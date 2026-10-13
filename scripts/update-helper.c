#define _DARWIN_C_SOURCE 1

#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/loader.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* This helper is shipped with the installed app, never with an update payload.
 * It only installs an already downloaded and validated Inkleaf app bundle.
 * Both paths remain present during a same-volume RENAME_SWAP; the old app is
 * deliberately retained at staged_path after a successful installation. */

static char failure[1024];
static char target_path[PATH_MAX], staged_path[PATH_MAX], private_path[PATH_MAX];
static char target_name[NAME_MAX + 1], staged_name[NAME_MAX + 1];
static char ack_name[NAME_MAX + 1], result_name[NAME_MAX + 1];
static const char *update_version;
static int private_fd = -1, target_parent_fd = -1;

static bool fail(const char *message) {
  snprintf(failure, sizeof(failure), "%s", message);
  return false;
}

static bool system_fail(const char *message) {
  snprintf(failure, sizeof(failure), "%s: %s", message, strerror(errno));
  return false;
}

static bool split_path(const char *path, char *parent, char *name) {
  const char *slash = strrchr(path, '/');
  if (!slash || path[0] != '/' || !slash[1] || slash == path ||
      strlen(path) >= PATH_MAX || strlen(slash + 1) > NAME_MAX)
    return fail("Expected an absolute path with a parent directory");
  size_t length = (size_t)(slash - path);
  memcpy(parent, path, length);
  parent[length] = '\0';
  strcpy(name, slash + 1);
  return true;
}

/* Requiring the input to equal realpath rejects symlinked components, '..',
 * repeated separators and paths whose meaning could change while installing. */
static bool real_directory(const char *path, struct stat *info) {
  char resolved[PATH_MAX];
  if (lstat(path, info) != 0 || !S_ISDIR(info->st_mode))
    return fail("An installation directory is missing or is a symbolic link");
  if (!realpath(path, resolved) || strcmp(path, resolved) != 0)
    return fail("Installation paths must be real directories without symbolic links");
  return true;
}

static bool real_file(const char *path, struct stat *info) {
  char resolved[PATH_MAX];
  if (lstat(path, info) != 0 || !S_ISREG(info->st_mode))
    return fail("An update file is missing or is not a regular file");
  if (!realpath(path, resolved) || strcmp(path, resolved) != 0)
    return fail("Update files must not contain symbolic links");
  return true;
}

static bool safe_output(const char *path, char *name) {
  char parent[PATH_MAX];
  struct stat info;
  if (!split_path(path, parent, name) || strcmp(parent, private_path) != 0)
    return fail("Update state files must be inside the private staging directory");
  if (!strcmp(name, ".") || !strcmp(name, "..") || !strcmp(name, staged_name))
    return fail("Invalid update state file name");
  if (fstatat(private_fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0) {
    if (!S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_nlink != 1)
      return fail("An update state file is not a private regular file");
  } else if (errno != ENOENT) {
    return system_fail("Cannot inspect update state file");
  }
  return true;
}

static void json_string(FILE *stream, const char *value) {
  fputc('"', stream);
  for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
    if (*p == '"' || *p == '\\') {
      fputc('\\', stream);
      fputc(*p, stream);
    } else if (*p < 0x20) {
      fprintf(stream, "\\u%04x", *p);
    } else {
      fputc(*p, stream);
    }
  }
  fputc('"', stream);
}

static bool write_result(const char *state, const char *message) {
  if (private_fd < 0 || !result_name[0]) return false;
  char temporary[NAME_MAX + 1];
  snprintf(temporary, sizeof(temporary), ".result-%ld-%08x.tmp", (long)getpid(), arc4random());
  int fd = openat(private_fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0) return false;
  FILE *stream = fdopen(fd, "w");
  if (!stream) { close(fd); unlinkat(private_fd, temporary, 0); return false; }
  fputs("{\"state\":", stream); json_string(stream, state);
  fputs(",\"message\":", stream); json_string(stream, message);
  fputs(",\"version\":", stream); json_string(stream, update_version);
  fputs(",\"backupPath\":", stream); json_string(stream, staged_path);
  fputs("}\n", stream);
  bool okay = !ferror(stream) && fflush(stream) == 0 && fsync(fd) == 0;
  if (fclose(stream) != 0) okay = false;
  if (okay && renameat(private_fd, temporary, private_fd, result_name) != 0) okay = false;
  if (!okay) unlinkat(private_fd, temporary, 0);
  return okay;
}

static bool child_success(pid_t child) {
  int status;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) return system_fail("Cannot wait for system tool");
  }
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
    return fail("A system tool failed");
  return true;
}

static bool plist_value(const char *plist, const char *key, char *value, size_t capacity) {
  int descriptors[2];
  if (pipe(descriptors) != 0) return system_fail("Cannot create plist tool pipe");
  char command[128];
  snprintf(command, sizeof(command), "Print :%s", key);
  pid_t child = fork();
  if (child < 0) { close(descriptors[0]); close(descriptors[1]); return system_fail("Cannot launch plist tool"); }
  if (child == 0) {
    close(descriptors[0]);
    if (dup2(descriptors[1], STDOUT_FILENO) < 0) _exit(127);
    close(descriptors[1]);
    char *const arguments[] = {"/usr/libexec/PlistBuddy", "-c", command, (char *)plist, NULL};
    execv(arguments[0], arguments);
    _exit(127);
  }
  close(descriptors[1]);
  size_t used = 0;
  bool overflow = false, read_error = false;
  char buffer[256];
  for (;;) {
    ssize_t count = read(descriptors[0], buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) {
      if (errno == EINTR) continue;
      read_error = true;
      break;
    }
    if ((size_t)count > capacity - 1 - used) overflow = true;
    if (!overflow) { memcpy(value + used, buffer, (size_t)count); used += (size_t)count; }
  }
  close(descriptors[0]);
  bool okay = child_success(child);
  if (read_error || overflow) return fail("Invalid or oversized bundle metadata");
  if (!okay) return false;
  while (used > 0 && (value[used - 1] == '\n' || value[used - 1] == '\r')) --used;
  value[used] = '\0';
  if (!used || memchr(value, '\n', used) || memchr(value, '\r', used))
    return fail("Invalid bundle metadata");
  return true;
}

static bool validate_bundle(const char *path, const char *version) {
  struct stat info;
  if (!real_directory(path, &info)) return false;
  char contents[PATH_MAX], plist[PATH_MAX], macos[PATH_MAX], executable[PATH_MAX];
  if (snprintf(contents, sizeof(contents), "%s/Contents", path) >= (int)sizeof(contents) ||
      snprintf(plist, sizeof(plist), "%s/Contents/Info.plist", path) >= (int)sizeof(plist) ||
      snprintf(macos, sizeof(macos), "%s/Contents/MacOS", path) >= (int)sizeof(macos) ||
      snprintf(executable, sizeof(executable), "%s/Contents/MacOS/Inkleaf", path) >= (int)sizeof(executable))
    return fail("Bundle path is too long");
  if (!real_directory(contents, &info) || !real_directory(macos, &info) || !real_file(plist, &info)) return false;
  char value[256];
  if (!plist_value(plist, "CFBundleIdentifier", value, sizeof(value)) ||
      strcmp(value, "com.fovercon.inkleaf") != 0)
    return fail("Update bundle identifier does not match Inkleaf");
  if (!plist_value(plist, "CFBundleExecutable", value, sizeof(value)) || strcmp(value, "Inkleaf") != 0)
    return fail("Update bundle executable does not match Inkleaf");
  if (!plist_value(plist, "CFBundlePackageType", value, sizeof(value)) || strcmp(value, "APPL") != 0)
    return fail("Update bundle is not an application");
  if (!plist_value(plist, "CFBundleShortVersionString", value, sizeof(value)) ||
      (version && strcmp(value, version) != 0))
    return fail("Update bundle version does not match the release");
  if (!real_file(executable, &info) || !(info.st_mode & 0111))
    return fail("The Inkleaf executable is not a regular executable file");
  int fd = open(executable, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return system_fail("Cannot read the Inkleaf executable");
  struct mach_header_64 header;
  ssize_t count = pread(fd, &header, sizeof(header), 0);
  close(fd);
  if (count != (ssize_t)sizeof(header) || header.magic != MH_MAGIC_64 ||
      header.cputype != CPU_TYPE_ARM64 || header.filetype != MH_EXECUTE)
    return fail("The update executable is not a native Apple silicon Mach-O application");
  return true;
}

static bool verify_zip(const char *path, const char *expected) {
  struct stat initial, actual, final;
  if (!real_file(path, &initial)) return false;
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) return system_fail("Cannot read the update archive");
  if (fstat(fd, &actual) != 0 || !S_ISREG(actual.st_mode) || actual.st_dev != initial.st_dev ||
      actual.st_ino != initial.st_ino || actual.st_size <= 0) {
    close(fd); return fail("The update archive changed before verification");
  }
  CC_SHA256_CTX context;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CC_SHA256_Init(&context);
  unsigned char buffer[65536], digest[CC_SHA256_DIGEST_LENGTH];
  off_t total = 0;
  for (;;) {
    ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) {
      if (errno == EINTR) continue;
      close(fd); return system_fail("Cannot verify the update archive");
    }
    total += count;
    CC_SHA256_Update(&context, buffer, (CC_LONG)count);
  }
  CC_SHA256_Final(digest, &context);
#pragma clang diagnostic pop
  bool unchanged = fstat(fd, &final) == 0 && total == actual.st_size && final.st_size == actual.st_size &&
      final.st_mtimespec.tv_sec == actual.st_mtimespec.tv_sec &&
      final.st_mtimespec.tv_nsec == actual.st_mtimespec.tv_nsec;
  close(fd);
  char calculated[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  for (size_t i = 0; i < sizeof(digest); ++i) snprintf(calculated + i * 2, 3, "%02x", digest[i]);
  if (!unchanged || strcmp(calculated, expected) != 0)
    return fail("The update archive failed SHA-256 verification");
  return true;
}

static double monotonic_seconds(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (double)now.tv_sec + (double)now.tv_nsec / 1000000000.0;
}

static void short_pause(void) {
  struct timespec delay = {.tv_sec = 0, .tv_nsec = 200000000};
  while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
}

static bool wait_for_exit(pid_t process) {
  double deadline = monotonic_seconds() + 60.0;
  while (kill(process, 0) == 0 || errno == EPERM) {
    if (monotonic_seconds() >= deadline) return fail("Inkleaf did not exit; the original app was left unchanged");
    short_pause();
  }
  if (errno != ESRCH) return system_fail("Cannot determine whether Inkleaf exited");
  return true;
}

static bool launch_bundle(const char *bundle_path, const char *nonce) {
  pid_t child = fork();
  if (child < 0) return system_fail("Cannot start the application launcher");
  if (child == 0) {
    if (nonce) {
      char *const arguments[] = {"/usr/bin/open", "-n", (char *)bundle_path, "--args", "--inkleaf-update", (char *)nonce, NULL};
      execv(arguments[0], arguments);
    } else {
      char *const arguments[] = {"/usr/bin/open", "-n", (char *)bundle_path, NULL};
      execv(arguments[0], arguments);
    }
    _exit(127);
  }
  return child_success(child);
}

static bool launch_app(const char *nonce) {
  return launch_bundle(target_path, nonce);
}

static bool acknowledged(const char *nonce) {
  int fd = openat(private_fd, ack_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return false;
  struct stat info;
  size_t length = strlen(nonce);
  bool okay = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == getuid() &&
      info.st_nlink == 1 && info.st_size == (off_t)length;
  char contents[129];
  ssize_t count = okay ? pread(fd, contents, sizeof(contents), 0) : -1;
  close(fd);
  return okay && count == (ssize_t)length && memcmp(contents, nonce, length) == 0;
}

static bool stable_version(const char *version) {
  if (!version[0] || strlen(version) > 64) return false;
  int components = 1;
  bool digit = false;
  for (const char *p = version; *p; ++p) {
    if (*p >= '0' && *p <= '9') digit = true;
    else if (*p == '.' && digit) { ++components; digit = false; }
    else return false;
  }
  return components == 3 && digit;
}

static bool valid_nonce(const char *nonce) {
  size_t length = strlen(nonce);
  if (length < 16 || length > 128) return false;
  for (const char *p = nonce; *p; ++p)
    if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
          (*p >= '0' && *p <= '9') || *p == '-' || *p == '_')) return false;
  return true;
}

static bool sha256_text(const char *hash) {
  if (strlen(hash) != 64) return false;
  for (const char *p = hash; *p; ++p)
    if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f'))) return false;
  return true;
}

static bool same_directory(const struct stat *a, const struct stat *b) {
  return S_ISDIR(b->st_mode) && a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}

static bool atomic_swap(void) {
  if (renameatx_np(target_parent_fd, target_name, private_fd, staged_name, RENAME_SWAP) != 0)
    return system_fail("Atomic replacement is unavailable; no non-atomic replacement was attempted");
  return true;
}

int main(int argc, char **argv) {
  if (argc != 10) {
    fprintf(stderr, "Usage: update-helper TARGET_APP STAGED_APP ZIP SHA256 PARENT_PID ACK_PATH NONCE VERSION RESULT_PATH\n");
    return 1;
  }
  update_version = argv[8];
  if (!stable_version(update_version) || !valid_nonce(argv[7]) || !sha256_text(argv[4])) {
    fprintf(stderr, "Invalid update version, nonce or SHA-256 digest\n");
    return 1;
  }
  char *end;
  errno = 0;
  long parent = strtol(argv[5], &end, 10);
  if (errno || !argv[5][0] || *end || parent <= 1 || parent > INT_MAX || parent == getpid()) {
    fprintf(stderr, "Invalid parent process identifier\n");
    return 1;
  }
  char target_parent[PATH_MAX], private_parent[PATH_MAX], private_name[NAME_MAX + 1];
  struct stat original_target, original_staged, parent_info, private_info;
  if (!split_path(argv[1], target_parent, target_name) || strcmp(target_name, "Inkleaf.app") != 0 ||
      !split_path(argv[2], private_path, staged_name) || strcmp(staged_name, "Inkleaf.app") != 0 ||
      strlen(argv[1]) >= sizeof(target_path) || strlen(argv[2]) >= sizeof(staged_path)) {
    fprintf(stderr, "Invalid Inkleaf installation paths\n");
    return 1;
  }
  strcpy(target_path, argv[1]);
  strcpy(staged_path, argv[2]);
  if (!split_path(private_path, private_parent, private_name) || strcmp(private_parent, target_parent) != 0 ||
      strncmp(private_name, ".inkleaf-update-", strlen(".inkleaf-update-")) != 0 ||
      !real_directory(target_parent, &parent_info) || !real_directory(private_path, &private_info) ||
      private_info.st_uid != getuid() || (private_info.st_mode & 0777) != 0700 ||
      private_info.st_dev != parent_info.st_dev) {
    fprintf(stderr, "The staging directory must be a private, same-volume directory next to Inkleaf\n");
    return 1;
  }
  private_fd = open(private_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  target_parent_fd = open(target_parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (private_fd < 0 || target_parent_fd < 0 ||
      !safe_output(argv[6], ack_name) || !safe_output(argv[9], result_name) || !strcmp(ack_name, result_name)) {
    fprintf(stderr, "Cannot open private update state files: %s\n", failure);
    return 1;
  }
  int lock_fd = openat(target_parent_fd, ".inkleaf-update.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  struct stat lock_info;
  if (lock_fd < 0 || fstat(lock_fd, &lock_info) != 0 || !S_ISREG(lock_info.st_mode) ||
      lock_info.st_uid != getuid() || lock_info.st_nlink != 1 || flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
    fail("Another update is in progress or the installation directory is not writable");
    goto error;
  }
  if (strstr(target_path, "/AppTranslocation/") || !strncmp(target_path, "/Volumes/", 9)) {
    fail("Move Inkleaf to a writable application directory before updating");
    goto error;
  }
  if (!real_directory(target_path, &original_target) || !real_directory(staged_path, &original_staged) ||
      original_target.st_dev != original_staged.st_dev ||
      !validate_bundle(target_path, NULL) || !validate_bundle(staged_path, update_version) || !verify_zip(argv[3], argv[4]))
    goto error;
  if (!write_result("waiting", "Ready to install after Inkleaf exits")) {
    fail("Cannot persist the update transaction");
    goto error;
  }
  if (!wait_for_exit((pid_t)parent)) goto error;
  struct stat latest_target, latest_staged, latest_private, latest_parent;
  if (fstat(target_parent_fd, &latest_parent) != 0 || fstat(private_fd, &latest_private) != 0 ||
      !same_directory(&parent_info, &latest_parent) || !same_directory(&private_info, &latest_private) ||
      !real_directory(target_path, &latest_target) || !real_directory(staged_path, &latest_staged) ||
      !same_directory(&original_target, &latest_target) || !same_directory(&original_staged, &latest_staged) ||
      latest_target.st_dev != latest_staged.st_dev ||
      !validate_bundle(target_path, NULL) || !validate_bundle(staged_path, update_version) || !verify_zip(argv[3], argv[4])) {
    fail("The app or update files changed while waiting for Inkleaf to exit");
    goto error;
  }
  if (!atomic_swap()) goto error;
  if (!write_result("restarting", "The old version is retained as a backup")) {
    fprintf(stderr, "Unable to persist restart state; attempting to restore the previous app\n");
    if (atomic_swap()) {
      write_result("rolled-back", "Update state could not be persisted; the previous app was restored");
      if (!launch_app(NULL)) fprintf(stderr, "The previous app was restored but could not be launched: %s\n", failure);
    } else {
      fprintf(stderr, "The previous app could not be restored: %s\n", failure);
      write_result("needs-recovery", "Update state could not be persisted or rolled back; both app bundles were retained");
      if (!launch_app(argv[7])) {
        fprintf(stderr, "The new app could not be launched; attempting to open the retained previous app\n");
        if (!launch_bundle(staged_path, NULL)) fprintf(stderr, "The retained previous app could not be launched: %s\n", failure);
      }
    }
    return 2;
  }
  if (!launch_app(argv[7])) {
    if (!atomic_swap()) {
      write_result("needs-recovery", "The new app could not launch and the original app could not be restored");
      fprintf(stderr, "%s\n", failure);
      if (!launch_bundle(staged_path, NULL)) fprintf(stderr, "The retained previous app could not be launched: %s\n", failure);
      return 2;
    }
    write_result("rolled-back", "The new app could not launch; the previous app was restored");
    if (!launch_app(NULL)) fprintf(stderr, "The previous app was restored but could not be launched\n");
    return 1;
  }
  double deadline = monotonic_seconds() + 90.0;
  while (monotonic_seconds() < deadline) {
    if (acknowledged(argv[7])) {
      if (!write_result("installed", "Inkleaf confirmed that the new version is ready")) {
        fprintf(stderr, "The new app started but installation state could not be persisted\n");
        return 2;
      }
      return 0;
    }
    short_pause();
  }
  write_result("needs-recovery", "The new app did not confirm readiness; the previous app is retained for recovery");
  fprintf(stderr, "The new app did not confirm readiness; no running app was terminated or replaced\n");
  return 2;

error:
  write_result("error", failure);
  fprintf(stderr, "%s\n", failure);
  return 1;
}

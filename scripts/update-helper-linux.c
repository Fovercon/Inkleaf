#define _GNU_SOURCE 1

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
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

/* AppImage updater: this helper comes from the installed app, never an update.
 * Only libc and coreutils sha256sum are required. No shell, privilege escalation,
 * Chromium sandbox switch, or execution of downloaded setup scripts is used. */

static char failure[1024];
static char target_path[PATH_MAX], staged_path[PATH_MAX], private_path[PATH_MAX];
static char target_name[NAME_MAX + 1], staged_name[NAME_MAX + 1];
static const char *backup_name = "previous.AppImage";
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
  static unsigned int sequence = 0;
  /* The directory is private and O_EXCL prevents collisions. Avoid arc4random,
   * which is absent from older glibc versions supported by Electron. */
  snprintf(temporary, sizeof(temporary), ".result-%ld-%u.tmp", (long)getpid(), ++sequence);
  int fd = openat(private_fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0) return false;
  FILE *stream = fdopen(fd, "w");
  if (!stream) { close(fd); unlinkat(private_fd, temporary, 0); return false; }
  fputs("{\"state\":", stream); json_string(stream, state);
  fputs(",\"message\":", stream); json_string(stream, message);
  fputs(",\"version\":", stream); json_string(stream, update_version);
  fputs(",\"backupPath\":", stream); char backup[PATH_MAX];
  snprintf(backup, sizeof(backup), "%s/%s", private_path, backup_name);
  json_string(stream, backup);
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

static bool validate_image(const char *path, bool executable) {
  struct stat info;
  if (!real_file(path, &info) || info.st_uid != getuid() || info.st_size < 64 ||
      (executable && !(info.st_mode & 0111))) return fail("AppImage must be a regular file owned by this user");
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return system_fail("Cannot read the AppImage");
  unsigned char header[64] = {0};
  ssize_t count = pread(fd, header, sizeof(header), 0);
  close(fd);
#if defined(__x86_64__)
  unsigned int machine = 62;
#elif defined(__aarch64__) || defined(__arm64__)
  unsigned int machine = 183;
#else
  unsigned int machine = 0;
#endif
  unsigned int actual_machine = (unsigned int)header[18] | ((unsigned int)header[19] << 8);
  unsigned int type = (unsigned int)header[16] | ((unsigned int)header[17] << 8);
  if (count != (ssize_t)sizeof(header) || !machine || memcmp(header, "\177ELF", 4) ||
      header[4] != 2 || header[5] != 1 || header[6] != 1 ||
      header[8] != 'A' || header[9] != 'I' || header[10] != 2 ||
      actual_machine != machine || (type != 2 && type != 3) || header[52] != 64 || header[53] != 0)
    return fail("The update is not a type-2 AppImage for this processor");
  return true;
}

/* Feed the already opened regular file to coreutils on stdin. No shell or
 * shared libcrypto dependency is used, and sha256sum never follows a filename. */
static bool verify_image(const char *path, const char *expected) {
  struct stat initial, actual, final;
  if (!real_file(path, &initial)) return false;
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return system_fail("Cannot read the AppImage for verification");
  if (fstat(fd, &actual) || !S_ISREG(actual.st_mode) || actual.st_ino != initial.st_ino ||
      actual.st_dev != initial.st_dev || actual.st_size <= 0) {
    close(fd); return fail("AppImage changed before verification");
  }
  int descriptors[2];
  if (pipe(descriptors)) { close(fd); return system_fail("Cannot create checksum pipe"); }
  pid_t child = fork();
  if (child < 0) { close(fd); close(descriptors[0]); close(descriptors[1]); return system_fail("Cannot start checksum verification"); }
  if (child == 0) {
    close(descriptors[0]);
    if (dup2(fd, STDIN_FILENO) < 0 || dup2(descriptors[1], STDOUT_FILENO) < 0) _exit(127);
    close(fd); close(descriptors[1]);
    char *const arguments[] = {"/usr/bin/sha256sum", NULL};
    execv(arguments[0], arguments);
    _exit(127);
  }
  close(descriptors[1]);
  char output[128]; size_t used = 0;
  for (;;) {
    ssize_t count = read(descriptors[0], output + used, sizeof(output) - 1 - used);
    if (count == 0) break;
    if (count < 0) { if (errno == EINTR) continue; break; }
    used += (size_t)count;
    if (used == sizeof(output) - 1) break;
  }
  close(descriptors[0]); output[used] = '\0';
  bool okay = child_success(child) && used >= 67 && !memcmp(output, expected, 64) &&
      output[64] == ' ' && output[65] == ' ' && output[66] == '-';
  bool unchanged = fstat(fd, &final) == 0 && final.st_size == actual.st_size && final.st_mtime == actual.st_mtime;
  close(fd);
  if (!okay || !unchanged) return fail("AppImage failed SHA-256 verification or sha256sum is unavailable");
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
  int descriptors[2];
  if (pipe(descriptors)) return system_fail("Cannot create application launch pipe");
  if (fcntl(descriptors[1], F_SETFD, FD_CLOEXEC) < 0) {
    close(descriptors[0]); close(descriptors[1]); return system_fail("Cannot protect launch pipe");
  }
  pid_t child = fork();
  if (child < 0) { close(descriptors[0]); close(descriptors[1]); return system_fail("Cannot launch the AppImage"); }
  if (child == 0) {
    close(descriptors[0]);
    /* The new AppImage runtime supplies its own mount and executable paths. */
    unsetenv("APPIMAGE"); unsetenv("APPDIR"); unsetenv("ARGV0");
    char *const with_nonce[] = {(char *)bundle_path, "--inkleaf-update", (char *)nonce, NULL};
    char *const plain[] = {(char *)bundle_path, NULL};
    execv(bundle_path, nonce ? with_nonce : plain);
    int problem = errno;
    ssize_t ignored = write(descriptors[1], &problem, sizeof(problem)); (void)ignored;
    _exit(127);
  }
  close(descriptors[1]);
  int problem = 0;
  ssize_t count;
  do { count = read(descriptors[0], &problem, sizeof(problem)); } while (count < 0 && errno == EINTR);
  close(descriptors[0]);
  if (count == 0) return true; /* exec succeeded; the boot ACK verifies readiness. */
  if (count > 0) { child_success(child); errno = problem; return system_fail("Could not execute the AppImage"); }
  return system_fail("Cannot observe the AppImage launch");
}

static bool launch_app(const char *nonce) { return launch_bundle(target_path, nonce); }

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

/* Files can replace another file with one POSIX atomic rename. Link the old
 * inode into our private directory first so replacement never loses the backup. */
static bool atomic_install(void) {
  if (linkat(target_parent_fd, target_name, private_fd, backup_name, 0) != 0)
    return system_fail("Cannot retain the previous AppImage");
  if (fsync(private_fd) != 0) {
    system_fail("Cannot persist the AppImage backup");
    unlinkat(private_fd, backup_name, 0);
    return false;
  }
  if (renameat(private_fd, staged_name, target_parent_fd, target_name) != 0) {
    system_fail("Cannot atomically replace the AppImage");
    unlinkat(private_fd, backup_name, 0);
    return false;
  }
  return true;
}

static bool restore_previous(void) {
  const char *restore_name = "restore.AppImage";
  if (linkat(private_fd, backup_name, private_fd, restore_name, 0) != 0)
    return system_fail("Cannot prepare the retained previous AppImage");
  if (renameat(private_fd, restore_name, target_parent_fd, target_name) != 0)
    return system_fail("Cannot atomically restore the previous AppImage");
  return true;
}

static bool launch_previous(void) {
  char backup[PATH_MAX];
  if (snprintf(backup, sizeof(backup), "%s/%s", private_path, backup_name) >= (int)sizeof(backup)) return false;
  return launch_bundle(backup, NULL);
}

int main(int argc, char **argv) {
  bool parent_exited = false;
  if (argc != 10) {
    fprintf(stderr, "Usage: update-helper TARGET_APPIMAGE STAGED_APPIMAGE DOWNLOAD SHA256 PARENT_PID ACK_PATH NONCE VERSION RESULT_PATH\n");
    return 1;
  }
  update_version = argv[8];
  if (!stable_version(update_version) || !valid_nonce(argv[7]) || !sha256_text(argv[4])) {
    fprintf(stderr, "Invalid update version, nonce or SHA-256 digest\n"); return 1;
  }
  char *end; errno = 0;
  long parent = strtol(argv[5], &end, 10);
  if (errno || !argv[5][0] || *end || parent <= 1 || parent > INT_MAX || parent == getpid()) {
    fprintf(stderr, "Invalid parent process identifier\n"); return 1;
  }
  char target_parent[PATH_MAX], private_parent[PATH_MAX], private_name[NAME_MAX + 1];
  struct stat original_target, original_staged, parent_info, private_info;
  if (!split_path(argv[1], target_parent, target_name) || strncmp(target_name, "Inkleaf", 7) ||
      strlen(target_name) < 15 || strcmp(target_name + strlen(target_name) - 9, ".AppImage") ||
      !split_path(argv[2], private_path, staged_name) || strcmp(staged_name, "Inkleaf.AppImage") ||
      strlen(argv[1]) >= sizeof(target_path) || strlen(argv[2]) >= sizeof(staged_path)) {
    fprintf(stderr, "Invalid Inkleaf AppImage installation paths\n"); return 1;
  }
  strcpy(target_path, argv[1]); strcpy(staged_path, argv[2]);
  if (!split_path(private_path, private_parent, private_name) || strcmp(private_parent, target_parent) ||
      strncmp(private_name, ".inkleaf-update-", strlen(".inkleaf-update-")) ||
      !real_directory(target_parent, &parent_info) || !real_directory(private_path, &private_info) ||
      private_info.st_uid != getuid() || (private_info.st_mode & 0777) != 0700 || private_info.st_dev != parent_info.st_dev) {
    fprintf(stderr, "The staging directory must be private and next to the AppImage on the same volume\n"); return 1;
  }
  private_fd = open(private_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  target_parent_fd = open(target_parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (private_fd < 0 || target_parent_fd < 0 || !safe_output(argv[6], ack_name) ||
      !safe_output(argv[9], result_name) || !strcmp(ack_name, result_name) ||
      !strcmp(ack_name, backup_name) || !strcmp(result_name, backup_name)) {
    fprintf(stderr, "Cannot open private update state files: %s\n", failure); return 1;
  }
  int lock_fd = openat(target_parent_fd, ".inkleaf-update.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  struct stat lock_info;
  if (lock_fd < 0 || fstat(lock_fd, &lock_info) || !S_ISREG(lock_info.st_mode) ||
      lock_info.st_uid != getuid() || lock_info.st_nlink != 1 || flock(lock_fd, LOCK_EX | LOCK_NB)) {
    fail("Another update is in progress or the AppImage directory is not writable"); goto error;
  }
  /* Do not retain the old AppImage's temporary FUSE mount as our working
   * directory after it exits. The new runtime needs a stable working directory. */
  if (fchdir(target_parent_fd) != 0) { system_fail("Cannot enter the AppImage installation directory"); goto error; }
  if (!real_file(target_path, &original_target) || !real_file(staged_path, &original_staged) ||
      original_target.st_dev != original_staged.st_dev || original_target.st_nlink != 1 || original_staged.st_nlink != 1 ||
      !validate_image(target_path, true) || !validate_image(staged_path, true) ||
      !verify_image(argv[3], argv[4]) || !verify_image(staged_path, argv[4])) goto error;
  if (!write_result("waiting", "Ready to install after Inkleaf exits")) { fail("Cannot persist the update transaction"); goto error; }
  if (!wait_for_exit((pid_t)parent)) goto error;
  parent_exited = true;
  struct stat latest_target, latest_staged, latest_parent, latest_private;
  if (!real_file(target_path, &latest_target) || !real_file(staged_path, &latest_staged) ||
      !real_directory(target_parent, &latest_parent) || !real_directory(private_path, &latest_private) ||
      latest_parent.st_dev != parent_info.st_dev || latest_parent.st_ino != parent_info.st_ino ||
      latest_private.st_dev != private_info.st_dev || latest_private.st_ino != private_info.st_ino ||
      latest_private.st_uid != getuid() || (latest_private.st_mode & 0777) != 0700 ||
      original_target.st_dev != latest_target.st_dev || original_target.st_ino != latest_target.st_ino ||
      original_staged.st_dev != latest_staged.st_dev || original_staged.st_ino != latest_staged.st_ino ||
      latest_target.st_dev != latest_staged.st_dev || latest_target.st_nlink != 1 || latest_staged.st_nlink != 1 ||
      !validate_image(target_path, true) || !validate_image(staged_path, true) ||
      !verify_image(argv[3], argv[4]) || !verify_image(staged_path, argv[4])) {
    fail("The AppImage changed while waiting for Inkleaf to exit"); goto error;
  }
  if (!atomic_install()) goto error;
  if (!write_result("restarting", "The previous AppImage is retained as a backup")) {
    fprintf(stderr, "Cannot persist restart state; attempting to restore the previous AppImage\n");
    if (restore_previous()) { write_result("rolled-back", "The previous AppImage was restored"); launch_app(NULL); }
    else { write_result("needs-recovery", "The previous AppImage could not be restored"); if (!launch_app(argv[7])) launch_previous(); }
    return 2;
  }
  if (!launch_app(argv[7])) {
    if (restore_previous()) { write_result("rolled-back", "The new AppImage could not execute; the previous version was restored"); launch_app(NULL); }
    else { write_result("needs-recovery", "The new AppImage could not execute or be restored"); launch_previous(); }
    return 1;
  }
  double deadline = monotonic_seconds() + 90.0;
  while (monotonic_seconds() < deadline) {
    if (acknowledged(argv[7])) {
      if (!write_result("installed", "Inkleaf confirmed that the new version is ready")) {
        fprintf(stderr, "New AppImage is running but final state could not be persisted\n"); return 2;
      }
      return 0;
    }
    short_pause();
  }
  write_result("needs-recovery", "The new AppImage did not confirm readiness; the previous version is retained");
  fprintf(stderr, "No readiness confirmation; no running application was terminated or replaced\n");
  return 2;
error:
  write_result("error", failure); fprintf(stderr, "%s\n", failure);
  if (parent_exited && validate_image(target_path, true) && !launch_app(NULL))
    fprintf(stderr, "The previous AppImage could not be relaunched: %s\n", failure);
  return 1;
}

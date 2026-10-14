# 安装指南

从 [GitHub Releases](https://github.com/Fovercon/Inkleaf/releases/latest) 下载正式安装包。文件名中的版本与架构应与你下载的附件一致；`x64` 适用于 Intel / AMD 64 位处理器，`arm64` 适用于 ARM64。

## macOS

当前提供 Apple Silicon / ARM64 包：

1. 下载 `Inkleaf-版本号-mac-arm64.zip` 并解压。
2. 将 `Inkleaf.app` 拖入「应用程序」。
3. 启动应用，选择 Markdown 文件或书库文件夹。

当前构建未经过 Developer ID 签名与公证。若系统拦截，请确认安装包来自本仓库 Releases，并按 macOS「隐私与安全性」中的提示操作。

## Ubuntu / Debian

桌面使用推荐 `.deb`。进入下载目录，用下载的完整文件名替换下方 `VERSION`：

```bash
sudo apt install ./Inkleaf-VERSION-linux-x64.deb
```

ARM64 机器使用文件名带 `arm64` 的附件。安装后，可从应用菜单打开，也可以运行：

```bash
inkleaf
inkleaf ./document.md
```

Ubuntu 22.04 x64、Ubuntu 24.04 x64 与 Ubuntu 24.04 ARM64 纳入自动化验证。Debian 尚未单独实测；依赖是否满足以系统包管理器检查结果为准。

## AppImage

下载与处理器对应的 AppImage，在下载目录用完整文件名替换 `VERSION`：

```bash
chmod +x Inkleaf-VERSION-linux-x64.AppImage
./Inkleaf-VERSION-linux-x64.AppImage
```

AppImage 的 FUSE 启动方式需要 FUSE 2 兼容库：Ubuntu 22.04 使用 `libfuse2`，Ubuntu 24.04 使用 `libfuse2t64`。Ubuntu 24.04 的 AppArmor 可能限制便携应用创建用户命名空间；如遇沙箱启动错误，推荐使用 `.deb` 安装包。

## 更新已有安装

| 安装方式 | 更新方式 |
| :-- | :-- |
| macOS `.app` | 在菜单或工具栏选择「检查更新」，下载后确认安装与重启 |
| Linux AppImage | 在应用内更新；文件及所在目录须可由当前用户写入 |
| Linux `.deb` | 下载新版 `.deb`，再次运行 `sudo apt install ./新版文件名.deb` |

软件内更新仅检查公开的正式 Release。macOS 0.1.0 未包含更新器，需要手动安装较新版本；0.2.0 / 0.2.1 如遇下载失败，可从 Releases 手动安装。

更新保留原有书库与设置。手动替换应用时，先保存文档并退出应用。

## 本地图片

预览支持相对路径、绝对路径和 `file://` 地址。可访问范围是当前书库以及成功打开的 Markdown 文档所在文件夹，目录外的符号链接不会扩大访问范围。

图片不显示时，检查预览中显示的路径与错误原因。Linux 文件名大小写遵循文件系统规则；文件缺失、权限不足或图片内容损坏需要分别处理。

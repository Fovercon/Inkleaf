# 墨页 · Inkleaf 0.5.5

## 阅读排版

- 重开排版面板时，最大宽度滑块、数值和正文预览会一起恢复保存值。继续拖动会从原来的位置开始。
- 控件采用统一高度和独立背景。宽度预设显示选中状态，关闭与恢复默认有清晰的主次区分。

## 大书库

- 重开书库时，按文件核对内容摘要并复用未变更的索引条目。跳过无链接和标签语法的全文解析，减少首开计算。
- 达到 200 篇文档或 16 MiB 时，反向链接照常显示，未链接提及可在侧栏点击查找。切换文档或收起面板会取消旧查找。

## Linux 安装

- AppImage 和 deb 提供标准尺寸图标，桌面入口与实际 X11 窗口类一致。Markdown 类型声明去重。
- Ubuntu 上的 AppImage 若遇 `chrome-sandbox` 启动错误，可按实际路径加载专用 AppArmor 规则，或用 deb 安装。Ubuntu 24.04 已验证专用规则下可启用 Chromium 沙箱启动。 [安装指南](https://github.com/Fovercon/Inkleaf/blob/v0.5.5/docs/INSTALLATION.md)

本版提供 macOS Apple Silicon ZIP、Linux x64 / ARM64 的 AppImage 和 deb。每个包均附 SHA-256 校验文件。AppImage 和 Mac 可通过软件内更新，deb 通过包管理器覆盖安装。

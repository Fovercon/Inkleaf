<div align="center">
  <img src="build/inkleaf-icon.png" alt="Inkleaf logo" width="104" />

  <h1>墨页 · Inkleaf</h1>
  <p><strong>让文字，安静生长。</strong></p>
  <p>A quiet place to read and write Markdown.</p>

  <p>
    <a href="https://github.com/Fovercon/Inkleaf/releases/latest"><img src="https://img.shields.io/github/v/release/Fovercon/Inkleaf?style=flat-square&color=487052" alt="Latest release" /></a>
    <a href="https://github.com/Fovercon/Inkleaf/actions/workflows/linux.yml"><img src="https://github.com/Fovercon/Inkleaf/actions/workflows/linux.yml/badge.svg?branch=main" alt="Linux validation" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-487052?style=flat-square" alt="macOS and Linux" />
    <img src="https://img.shields.io/badge/built%20with-Electron%20%2B%20TypeScript-2C342E?style=flat-square" alt="Electron and TypeScript" />
  </p>

  <p>
    <a href="https://github.com/Fovercon/Inkleaf/releases/latest">下载安装</a> ·
    <a href="#功能亮点">功能亮点</a> ·
    <a href="docs/INSTALLATION.md">安装指南</a> ·
    <a href="CONTRIBUTING.md">构建与贡献</a> ·
    <a href="https://github.com/Fovercon/Inkleaf/issues">反馈问题</a>
  </p>
</div>

---

Inkleaf 是一款面向 macOS 与 Linux 的 Markdown 阅读与编辑器。暖白纸面、墨色文字与叶绿色点缀，让阅读、写作和整理笔记拥有一个舒适、专注的空间。

笔记以普通 Markdown 文件存放在本地。打开一个文件夹，即可把它作为书库；从一页文字开始，逐渐连接你的想法。

![Inkleaf 编辑与阅读界面](docs/images/workspace.png)

## 功能亮点

| | 功能 | 说明 |
| :-- | :-- | :-- |
| 📖 | 阅读与写作 | 实时预览、双向滚动同步、多标签页、自动保存与会话恢复 |
| 🌿 | 舒适排版 | 浅色、羊皮纸、护眼绿与深色主题，支持跟随系统与字号调整 |
| 🗂️ | 本地书库 | 文件树、最近打开、拖拽整理、新建、重命名与系统废纸篓 |
| 🔎 | 快速查找 | 文件快速切换、全文搜索、正则搜索与可跳转大纲 |
| 🔗 | 连接笔记 | 双链、反向链接、标签索引与文档名补全 |
| 🧮 | 丰富内容 | GFM 表格、任务列表、代码高亮、KaTeX 公式、Mermaid 图表与 callout |
| 🖼️ | 图片体验 | 本地图片预览、粘贴插图、缩放灯箱与加载失败提示 |
| 📄 | 导出与扩展 | PDF、独立 HTML 导出，以及隔离运行的外部插件 |

<details>
<summary><strong>查看欢迎页与深色主题</strong></summary>

![Inkleaf 欢迎页](docs/images/welcome.png)

![Inkleaf 深色主题](docs/images/dark.png)

</details>

## 下载安装

前往 **[GitHub Releases](https://github.com/Fovercon/Inkleaf/releases/latest)**，选择与你的系统和处理器对应的附件。

| 系统 | 架构 | 安装包 | 使用方式 |
| :-- | :-- | :-- | :-- |
| macOS | Apple Silicon / ARM64 | `.zip` | 解压后将 `Inkleaf.app` 拖入「应用程序」 |
| Ubuntu / Debian | x64、ARM64 | `.deb` | 使用系统包管理器安装，推荐桌面用户使用 |
| Linux | x64、ARM64 | `.AppImage` | 赋予执行权限后运行 |

正式安装包的版本与可用平台以 Releases 附件为准。Ubuntu 22.04 x64、Ubuntu 24.04 x64 和 ARM64 纳入自动化验证；Debian 尚未单独实测。macOS 当前构建未经过 Developer ID 签名与公证，首次打开可能需要按系统安全提示授权。

完整命令、系统依赖和常见问题见 [安装指南](docs/INSTALLATION.md)。

## 开始使用

1. 点击 **打开书库**，选择存放 Markdown 文件的文件夹。
2. 从左侧文件树选择文档，在编辑与阅读面板之间自由切换。
3. 使用 `[[文档名]]` 连接笔记，用标签和搜索定位内容。
4. 在菜单中导出 PDF 或 HTML，分享你的文字。

本地图片可使用相对路径、绝对路径或 `file://` 地址。将图片放在当前书库或已打开文档的文件夹内；遇到路径、权限或解码问题时，预览会显示具体原因。

## 常用快捷键

| 操作 | macOS | Linux |
| :-- | :-- | :-- |
| 打开文件 / 书库 | `⌘ O` / `⌘ ⇧ O` | `Ctrl O` / `Ctrl Shift O` |
| 保存 | `⌘ S` | `Ctrl S` |
| 快速切换文件 | `⌘ P` | `Ctrl P` |
| 全文搜索 | `⌘ ⇧ F` | `Ctrl Shift F` |
| 新标签页打开文件 | `⌘ T` | `Ctrl T` |
| 关闭标签页 | `⌘ ⇧ W` | `Ctrl Shift W` |
| 显示 / 隐藏书库 | `⌘ \` | `Ctrl \` |
| 导出 PDF / HTML | `⌘ ⇧ P` / `⌘ ⇧ H` | `Ctrl Shift P` / `Ctrl Shift H` |
| 专注模式 | `⌘ ⇧ D` | `Ctrl Shift D` |

## 软件更新

macOS 与 Linux AppImage 支持在软件内检查和下载正式新版本，确认后安装并重启。更新包会核对 SHA-256、应用标识、版本和处理器架构。

通过 `.deb` 安装的应用会提供新版下载入口，随后由系统包管理器完成更新。软件只读取已公开的正式 Release；草稿与预发布版本不会进入更新渠道。

## 从源码运行

需要 Node.js 22、npm 及对应系统的原生编译工具。

```bash
git clone --branch dev https://github.com/Fovercon/Inkleaf.git
cd Inkleaf
npm ci
npm start
```

`dev` 用于日常开发；`main` 用于整理与验证正式发布源码。测试、目录说明和分支协作方式见 [贡献指南](CONTRIBUTING.md)，维护者发布步骤见 [发布指南](docs/RELEASING.md)。

## 反馈与贡献

欢迎通过 [Issues](https://github.com/Fovercon/Inkleaf/issues) 提交问题或建议。报告问题时，请提供应用版本、系统与架构、复现步骤；分享截图和示例文件前，请移除私人内容。

技术基础：Electron、TypeScript、CodeMirror 6、markdown-it、DOMPurify、KaTeX、Mermaid 与 esbuild。

## 许可证

项目当前标记为 **UNLICENSED**，尚未采用开源许可证。仓库公开不代表授予使用、修改或分发授权；第三方依赖遵循各自的许可证。

---

<div align="center">
  <sub>Read slowly. Write freely.</sub>
</div>

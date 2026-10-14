# 构建与贡献

## 分支约定

| 分支 | 用途 |
| :-- | :-- |
| `dev` | 日常开发、功能验证与内部开发资料 |
| `main` | 正式发布源码、公开文档与发布流程 |
| `codex/*` 或功能分支 | 独立修改，完成后向 `dev` 提交 Pull Request |

默认开发基线是 `dev`。正式发布时，从 `main` 创建候选分支，选择已验证的功能或修复提交；内部笔记、开发日志和验收产物留在 `dev`。不要把包含这些资料的整个开发分支直接合入 `main`。

`main` 和指向它的 Pull Request 会检查发布目录。版本标签只允许指向已纳入 `main` 的提交。

## 开发环境

- Node.js 22 与 npm。
- macOS：Xcode Command Line Tools。
- Linux：GCC；安装包构建另需 `dpkg` 与 `fpm`，界面测试需要桌面会话或 Xvfb。

```bash
git clone --branch dev https://github.com/Fovercon/Inkleaf.git
cd Inkleaf
npm ci
npm start
```

Linux 基础编译工具可通过 `sudo apt install build-essential` 安装。

## 项目结构

```text
.github/workflows/  自动化检查与发布
build/             应用图标与打包资源
docs/              安装、发布指南与产品截图
scripts/           构建、测试和更新助手
src/
  main/            Electron 主进程、文件与更新服务
  preload/         跨进程接口
  renderer/        编辑器、预览与界面
  shared/          类型与 IPC 契约
test-library/      界面回归所需的示例书库
tests/             自动化回归测试
```

测试书库属于可复用测试数据；`verify/`、`out/` 和 `dist/` 是生成目录，不提交到正式源码。

## 验证修改

按修改范围执行相关检查：

```bash
npm run typecheck
npm run test:regressions
npm run test:updates
npm run test:platform
```

界面改动使用真实 Electron 回归：

```bash
npm run test:doc-session-ui
npm run test:plugin-dom-ui
npm run test:bug-tickets-ui
npm run test:ui
```

Linux CI 使用 Xvfb 运行界面检查，并验证真实 AppImage 与实际安装的 `.deb`。测试使用独立配置和测试书库副本。

准备进入 `main` 时运行 `npm run check:release-tree`，检查暂存或已提交的发布目录；新文件需先暂存才会被检查。

## 提交问题与修改

问题报告应包含版本、操作系统、架构、复现步骤、预期与实际结果。提交修改时说明解决的问题和验证方式，避免提交个人路径、账号信息、临时输出或内部开发记录。

外部插件在隔离 iframe 中运行。使用公开命令、DOM 后处理与代码块处理接口，避免依赖宿主 DOM、文件接口、MarkdownIt 实例或同步 `when`。

## 许可证

当前项目为 `UNLICENSED`。提出或提交贡献前，请先通过 Issue 与维护者确认授权及贡献安排。

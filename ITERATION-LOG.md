# 迭代日志 / ITERATION LOG

Markdown Reader 自动化打磨记录。每轮流程：调研业界标杆（Typora / Obsidian / Mark Text）→ 实现 → 构建验证截图 → git 提交。

## 路线图

| 轮次 | 主题 | 对标 | 状态 |
|------|------|------|------|
| 0 | MVP：完整可用的阅读+编辑器 | — | ✅ 完成 |
| 1 | 阅读排版体验：字体层级、图片放大、链接细节 | Typora 渲染质量 | ✅ |
| 2 | 编辑体验：列表续行、快捷键、剪贴板贴图 | Typora 输入体验 | ⬜ |
| 3 | 导航：大纲增强、最近文件、面包屑 | Obsidian | ⬜ |
| 4 | 文件管理：重命名/删除/新建文件夹/过滤 | Obsidian | ⬜ |
| 5 | 全文搜索 + 快速切换器 | Obsidian Quick Switcher | ⬜ |
| 6 | 导出 PDF / HTML | Typora 导出 | ⬜ |
| 7 | 主题系统：多内置主题、自定义 CSS | Typora 主题 | ⬜ |
| 8 | 性能：大文件渲染、启动速度 | Mark Text | ⬜ |
| 9 | macOS 集成：文件关联、细节打磨 | 原生体验 | ⬜ |
| 10 | 终检回归 + 最终打包 | — | ⬜ |

## 第 0 轮 — MVP（基线）

日期：2026-10-13

**技术栈**：Electron + TypeScript + esbuild；CodeMirror 6；markdown-it + DOMPurify + highlight.js + @vscode/markdown-it-katex + mermaid（懒加载）；chokidar。

**已完成功能**：
- 四面板布局（书库树 / 编辑 / 预览 / 大纲），均可收起（⌘\ ⌘1 ⌘2 ⌘3）、可拖宽、布局持久化
- 文件夹书库：递归 .md 树、文件夹展开状态记忆、点击即读、外部修改自动刷新（自己保存后的写入会被忽略）
- 新建文件（⌘N）、右键菜单（新建 / 在 Finder 中显示）、拖拽文件夹或 .md 文件进窗口打开
- 编辑：CodeMirror 6 + GFM 语法高亮、⌘S 保存、停止输入 2 秒自动保存、脏状态标题指示
- 渲染：GFM 表格、任务列表、代码高亮（手写双主题 token 配色）、KaTeX 公式、Mermaid 图表（按需懒加载、随主题重绘）、相对路径图片走 `mdasset://` 自定义协议（限定书库根目录内）
- 滚动同步：基于 data-source-line 行号映射的双向同步
- 大纲：点击跳转、滚动高亮当前章节
- 主题：浅色/深色/跟随系统
- 会话恢复：书库路径、上次文件、每个文件的滚动位置
- 安全：contextIsolation 开启、DOMPurify 清洗、CSP、mdasset 协议路径白名单

**验证方式**：`npm run test:ui` 加载 test-library 并截图到 verify/round0.png。

**遗留 / 已知问题**（后续轮次处理）：
- 图片点击放大未实现（第 1 轮）
- 任务列表复选框只读（第 2 轮可交互写回文件）
- 大文件一次性整页渲染（第 8 轮优化）
- 打包 .app 未验证放入 /Applications（第 10 轮终检）

## 第 1 轮 — 阅读排版体验（对标 Typora / medium-zoom）

日期：2026-10-13

**改进内容**：
- 排版全面打磨：正文 16px / 行高 1.8（CJK 友好）、抗锯齿渲染、阅读宽度 800px、标题层级间距节奏化、任务列表缩进修正、嵌套列表间距、表格行高与内边距、代码块 13.5px、引用块改为 Typora 式纯左边线（去掉背景）
- 图片灯箱（新增 `lightbox.ts`）：点击任意图片全屏查看——变暗背景 + 毛玻璃、滚轮缩放（0.5–8x）、放大后拖拽平移、双击复位/放大 2x、Esc/点击背景关闭、alt 文字作说明；链接内图片不拦截、⌘点击远程图在浏览器打开原图
- 链接处理：外部链接悬停显示目标 URL（title 提示）
- 修复：`mdasset://` URL 构造 bug——空 host 被解析成路径首段（`mdasset:///Users/x` → host=users），导致图片 403；改为固定 host `mdasset://local/<abs-path>`。**此 bug 自第 0 轮就存在**，第 0 轮截图分析误报了图片正常
- 测试流程增强：`MDR_ROUND` 环境变量命名截图；自动点击图片生成灯箱验证图 `round{N}-lightbox.png`

**验证**：tsc 无错误；test:ui 双截图（布局 + 灯箱）均通过图像分析检查：灯箱遮罩/居中/说明文字全部正常，图片 naturalWidth=96 确认加载。

**遗留问题**：
- 任务列表复选框只读（第 2 轮）
- 图片灯箱从缩略图位置缩放进入的 FLIP 动画未做（当前淡入，已足够顺滑，可后续增强）
- 大文件整页渲染（第 8 轮）

## 构建与验证命令

- `npm run build` — esbuild 打包（main/preload CJS + renderer ESM 分包）
- `npm start` — 启动应用
- `npm run test:ui` — 测试模式：自动打开 test-library、8 秒后截图到 verify/ 并退出
- `npm run package` — electron-builder 产出 dist/mac-arm64/Markdown Reader.app

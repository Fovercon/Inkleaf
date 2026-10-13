# 墨页 · Inkleaf

让文字，安静生长。

面向 macOS 的个人 Markdown 阅读与编辑器。暖白纸面、墨色文字与叶绿色点缀，让阅读与写作回归舒适、专注。

![墨页 · Inkleaf 阅读与编辑界面](docs/images/workspace.png)

## 快速开始

```bash
npm install       # 安装依赖（.npmrc 已配置国内镜像）
npm start         # 开发模式启动
npm run test:ui   # 使用独立配置和测试书库副本，回归验证并截图到 verify/
npm run package   # 打包 dist/mac-arm64/Inkleaf.app
```

把 `Inkleaf.app` 拖入 `/Applications` 即可日常使用；Finder 中右键任意 `.md` 文件 → 打开方式 → 墨页 · Inkleaf。

## 视觉设计

- 暖白纸面 `#FBF9F4`、墨色文字 `#2C342E`、叶绿点缀 `#487052`。
- 书页与叶片标识、统一 SVG 线条图标、宋体标题与清晰的面板层级。
- 欢迎页、书库、编辑器、阅读预览、大纲与底部状态栏采用一致的配色。
- 保留五套主题和字号调节；小窗口自动分配面板空间，键盘焦点清晰可见。

![欢迎页](docs/images/welcome.png)

![深色主题](docs/images/dark.png)

## 功能总览

**阅读**
- 文件夹书库：文件树（展开状态记忆）、最近文件、树内过滤（高亮匹配）
- 渲染：GFM 表格/任务列表、代码高亮、KaTeX 数学公式、Mermaid 图表（懒加载 + 缓存）、相对路径图片（`mdasset://` 安全协议）
- 排版：16px 正文 / 1.8 行高，图片点击全屏灯箱（滚轮缩放、拖拽平移）
- 大纲：折叠子树、点击跳转、滚动跟随高亮
- 面包屑：点击文件夹在树中展开定位；返回顶部按钮
- 主题：自动 / 浅色 / 羊皮纸 / 护眼绿 / 深色；字号缩放 80%–160%

**编辑**
- CodeMirror 6 编辑器，GFM 语法高亮，⌘S + 2 秒自动保存（原生未保存圆点）
- 快捷键：⌘B 加粗 / ⌘I 斜体 / ⌘E 行内代码 / ⇧⌘K 代码块 / ⌘K 链接（智能切换）
- 列表 Enter 自动续行、Tab/⇧Tab 缩进；任务复选框点击回写源码
- 粘贴图片自动存 `assets/paste-时间戳.png` 并插入引用
- 编辑 ⇄ 预览双向滚动同步；字数与行列统计

**文件管理**
- 右键：新建文件/文件夹（行内命名）、重命名（路径级联联动）、删除（系统废纸篓）、Finder 定位
- 拖拽：文件拖入文件夹整理；外部文件夹/文件拖入窗口打开

**搜索**
- ⌘P 快速切换：文件名模糊匹配（评分排序 + 字符高亮），空查询显示最近
- ⇧⌘F 全书库全文搜索：按文件分组、行号 + 关键词高亮、点击直达行

**导出**
- ⇧⌘P 导出 PDF（A4、打印背景、分页防截断）
- ⇧⌘H 导出单文件 HTML（样式 + 图片 + KaTeX 字体全部内嵌，零依赖）

**macOS 集成**
- `.md`/`.markdown` 文件关联、Dock 菜单（含最近文件）、标题栏代理文件图标、自定义应用图标

## 快捷键速查

| 快捷键 | 功能 | | 快捷键 | 功能 |
|---|---|---|---|---|
| ⌘O / ⇧⌘O | 打开文件/文件夹 | | ⌘P | 快速切换文件 |
| ⌘N | 新建文件 | | ⇧⌘F | 全文搜索 |
| ⌘S | 保存 | | ⇧⌘P / ⇧⌘H | 导出 PDF/HTML |
| ⌘\ ⌘1 ⌘2 ⌘3 | 切换书库/编辑/预览/大纲 | | ⌘= ⌘- ⌘0 | 字号缩放 |
| ⌘B ⌘I ⌘E ⌘K | 加粗/斜体/代码/链接 | | ⇧⌘W | 关闭书库 |

## 架构

```
src/main       Electron 主进程：窗口、菜单、文件 IPC、chokidar 监听、
               mdasset/app 自定义协议、打印导出、Dock 菜单、会话
src/preload    contextBridge 安全 API（contextIsolation 开启）
src/renderer   渲染层（无框架 TypeScript）：
               main 布局总装 / fileTree / editor(CodeMirror) /
               preview(markdown-it 管线) / outline / lightbox /
               commandPalette / export / theme / state
```

技术栈：Electron + TypeScript + esbuild；CodeMirror 6；markdown-it + DOMPurify + highlight.js + KaTeX + Mermaid（懒加载分包）；chokidar；electron-builder。

安全：contextIsolation、CSP、DOMPurify 消毒、`mdasset://` 协议限定书库根目录内。

## 迭代历史

项目经 10 轮自动化迭代打磨，过程记录见 [ITERATION-LOG.md](ITERATION-LOG.md)，每轮均有截图证据（verify/）与 git 提交。

| 轮 | 主题 | 轮 | 主题 |
|---|---|---|---|
| 0 | MVP 基线 | 5 | 全文搜索 + 快速切换 |
| 1 | 阅读排版 + 图片灯箱 | 6 | 导出 PDF / HTML |
| 2 | 编辑体验 + 任务回写 + 贴图 | 7 | 五套主题 + 字号缩放 |
| 3 | 导航：面包屑/最近/大纲折叠 | 8 | 性能（缓存/防抖/双渲染修复） |
| 4 | 文件管理：重命名/删除/过滤 | 9 | macOS 原生集成 |
|  |  | 10 | 终检 + 树内拖拽 + 交付 |

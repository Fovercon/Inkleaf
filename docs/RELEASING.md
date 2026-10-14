# 发布指南

## 准备正式源码

1. 从 `main` 创建发布候选分支，纳入 `dev` 中已验证的功能与修复提交。
2. 保持公开文档、版本配置及发布目录检查通过；内部开发资料留在 `dev`。
3. 同步升级 `package.json`、`package-lock.json` 顶层和根包的版本，使用正式 `x.y.z` 格式。
4. 运行相关检查，向 `main` 提交 Pull Request；验证通过后合入。

可使用以下命令只更新项目版本，不自动创建标签：

```bash
npm version patch --no-git-tag-version --ignore-scripts
npm run typecheck
npm run check:release-tree
```

`main` 保持正式源码目录，发布标签必须指向已纳入 `main` 的提交。

## 创建版本标签

在干净的 `main` 工作区执行：

```bash
git switch main
git pull --ff-only origin main
version=$(node -p 'require("./package.json").version')
git tag -a "v$version" -m "Inkleaf $version"
git push origin "v$version"
```

标签必须与包版本完全一致。不要移动已发布版本的标签或覆盖正式 Release；修复需使用新的版本号。

## 自动化构建

`Build release` 工作流先检查目录、标签与 `main` 的提交关系，再构建并验证：

| 平台 | 附件 |
| :-- | :-- |
| macOS ARM64 | `Inkleaf-版本号-mac-arm64.zip` |
| Linux x64 | `Inkleaf-版本号-linux-x64.AppImage` 与 `.deb` |
| Linux ARM64 | `Inkleaf-版本号-linux-arm64.AppImage` 与 `.deb` |

每个安装包都有同名 `.sha256` 文件。Linux x64 产物同时在 Ubuntu 22.04 与 24.04 验证。

所有平台检查通过后，发布任务汇总五个安装包及校验文件，核对本地 SHA-256、附件大小与 GitHub 返回的摘要，创建完整 Release 草稿。

## 发布正式版本

检查草稿版本说明与附件后，在 GitHub 选择 **Publish release**。也可以手动运行 `Build release`，指定已有标签并勾选 `publish`；工作流仍须完成所有验证才会发布。

客户端只读取公开的正式 Release。草稿、预发布版本及仅推送的源码版本不会触发软件内更新。

## 本机打包

```bash
# macOS ARM64
npm run release:build -- --arch arm64

# 对应架构的原生 Linux
npm run release:linux -- --arch x64
npm run release:linux -- --arch arm64
```

产物位于 `dist/`。Linux 宿主架构须与目标架构一致。本机命令只构建附件，跨平台正式发布使用仓库工作流。

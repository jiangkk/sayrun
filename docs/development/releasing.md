# 发布与公开源码

[文档索引](../README.md) · 分类：开发维护 · 状态：当前

本文面向维护者，说明公开源码导出、发布验证、npm 发包与官网部署。开发环境和各类测试的要求见[构建与测试](testing.md)。

## 公开源码快照

首次公开建议从审核后的当前文件创建新的公开历史。修改最新文件不会移除旧提交中的业务信息；直接把原私有仓库改为公开仍会暴露旧分支、标签和历史。

```sh
npm run export:public -- /tmp/sayrun-public
```

导出使用固定的项目目录白名单，包含当前工作区的源码、测试、文档、官网和工作流，也包含尚未提交的新文件。它不复制 `.git`、依赖、构建产物、运行数据、环境文件、凭证文件和本地包；拒绝符号链接以及已存在的目标目录。导出操作不会初始化 Git、提交代码或推送远端。

导出不等于安全审计。发布前检查内容，并对快照运行密钥扫描和下面的验证。旧私有历史可以继续保留用于开发和追溯；公开仓库应只使用清理后的历史。如果继续使用原仓库，需要在改变可见性前单独处理远端的所有分支、标签及相关引用。

仓库 CI 包含 Gitleaks 历史扫描。CI 默认适用于个人账号；转移到组织后，需要按 [Gitleaks Action 文档](https://github.com/gitleaks/gitleaks-action) 配置其许可，或换成 Gitleaks CLI。

## 发布验证

按[构建与测试](testing.md#开发环境)准备环境，在仓库根目录运行：

```sh
npm ci --registry=https://registry.npmjs.org
npm test
npm run test:pty
npm run test:package
```

`npm test` 自动完成类型检查和构建。安装回归使用临时安装前缀，并校验 npm 包的文件白名单。真实 DSH 的可选离线恢复检查为 `npm run test:dsh`，无需真实模型密钥。

GitHub CI 配置了 macOS 和 Linux；在对应 CI 实际通过前，文档继续将 macOS / Apple Silicon 标为已验证平台。

CI 使用 Node.js 22 的默认 npm 模式，并额外配置 Node.js 26.4.0 的 `engine-strict` 检查。OpenTUI 的 Node.js 引擎声明会使 Node.js 22 安装出现警告；Bun 界面运行与严格 npm 安装属于不同的验证项，发布说明需保留这一限制。

## npm

1. 更新 `package.json`、`package-lock.json` 中的版本和 `CHANGELOG.md`，明确实验能力和验证平台。
2. 完成上述检查，运行 `npm pack --dry-run`，确认包含 `LICENSE`、README、构建资产和预览图片，没有凭证或运行记录。
3. 通过维护者自己的 npm 身份发布。`prepublishOnly` 会重新构建；发布不会自动修改 shell 配置。

许可证使用 [MIT](../../LICENSE)。外部依赖保持各自的许可证；当前发布包不内嵌 DSH，由使用者单独安装。

### 发布包内容

`prepack` 和 `prepublishOnly` 都调用构建，分别覆盖 `npm pack` 和 `npm publish`。发布白名单包含 `dist/` 和 README 使用的 `docs/images/approval-preview.png`；npm 还会自动包含根目录 `README.md` 和必需的 `package.json`。README 通过公共 npm CDN 加载这张 PNG，不依赖 GitHub 仓库是否公开。其余详细文档、SVG、源码、构建脚本、测试和 TypeScript 配置不进入安装包。`dist/` 不提交到 Git，消费者安装 tarball 不需要源码或执行构建。

```sh
npm pack --dry-run
npm pack
# 确认发布目标和账号后再手动 npm publish；本仓库不会自动发布。
```

### 发布与确认

npm 包名为 `sayrun-shell`，CLI 名称仍为 `sayrun`。`publishConfig` 固定发布到官方 registry，并将访问级别设为 public。手动发布可执行 `npm publish --access=public --registry=https://registry.npmjs.org/`。

`npm publish` 返回成功或 `202 Accepted` 只表示上传已被接收。npm 会在版本公开前扫描，期间可能提示 `Your package is being processed`。发布后应查询官方 registry，确认目标版本及 `latest` 标签都已生效：

```zsh
npm view sayrun-shell@0.1.2 version --registry=https://registry.npmjs.org/
npm view sayrun-shell dist-tags --json --registry=https://registry.npmjs.org/
```

将示例中的版本号替换为本次目标版本。如果持续查不到版本，请登录 npm 维护者账号检查发布状态和通知；公开接口的 404 无法区分等待扫描、人工复核与拦截。README 的图片修复也要随新版本成功发布后，才会在 npm 和公共 CDN 生效。

## 官网与 GitHub Pages

`website/` 为纯静态官网。主仓库发布的目标地址为 <https://jiangkk.github.io/sayrun/>；部署前原有 `sayrun-site` 站点仍是独立部署。

首次启用主仓库官网时：

1. 先完成公开历史迁移，并确认 `jiangkk/sayrun` 可以公开。
2. 在仓库 Settings → Pages 中将 Source 设为 GitHub Actions。
3. 从 Actions 手动运行 `Deploy website`；后续 `main` 上的官网改动会自动部署。
4. 验证首页、使用文档、样式、交互和 sitemap，再更新对外链接。旧站可以随后改成跳转页。

Pages 工作流只上传 `website/`，不上传项目源码、配置或历史。它仅在公开的 `jiangkk/sayrun` 仓库运行；不会改变仓库可见性，也不会自动发布 npm 包。

如果暂时保持主仓库私有，可以继续使用独立官网，或将官网内容放入 `jiangkk/jiangkk.github.io` 的 `sayrun/` 子目录。在切换部署方式时，同步检查 canonical URL、Open Graph URL、robots 和 sitemap。

公开仓库还应启用 Private vulnerability reporting，使 [安全策略](../../SECURITY.md) 中的私密入口可用。

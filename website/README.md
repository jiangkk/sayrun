# Sayrun 官网

主仓库部署目标：[Sayrun 官网](https://jiangkk.github.io/sayrun/)。

首次部署前，原有 `https://jiangkk.github.io/sayrun-site/` 仍由独立仓库提供。本目录的 canonical、Open Graph 和 sitemap 已准备为新的主仓库路径。

这是 Sayrun 的独立静态官网，包含交互演示、安装指引和使用文档。演示只在浏览器中展示示例数据，不调用模型，不执行本机命令。

官网使用说明为手工维护的 HTML，用户行为以[使用手册](../docs/guide/usage.md)为完整说明；修改相关行为时同步核对首页与 `docs.html`。仓库文档分类与同步要求见[文档维护规范](../docs/development/documentation.md)。

## 本地预览

在本目录运行：

```sh
python3 -m http.server 4173
```

打开[本地预览](http://localhost:4173/)。无需安装依赖或构建。

## 发布

`.github/workflows/pages.yml` 从 `main` 的本目录发布静态文件。它只在公开的 `jiangkk/sayrun` 仓库运行，首次需要在仓库 Settings → Pages 中选择 GitHub Actions，再手动触发 `Deploy website`；后续官网文件变更会自动部署。完整切换步骤见 [发布说明](../docs/development/releasing.md)。

`.nojekyll` 禁用 Jekyll。部署只上传本目录，不包含 CLI 源码、配置、凭证或历史记录。现有独立站需要在新站验证后单独切换或配置跳转。

所有样式、脚本和图标均使用相对地址，适用于 GitHub Pages 项目路径。站点不依赖私有 GitHub 图片或 npm CDN，不包含 CLI 源码、凭证、运行状态或用户任务数据。

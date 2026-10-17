# Sayrun 官网

官网地址：https://jiangkk.github.io/sayrun-site/

这是 Sayrun 的独立静态官网，包含交互演示、安装指引和使用文档。演示只在浏览器中展示示例数据，不调用模型，不执行本机命令。

## 本地预览

在本目录运行：

```sh
python3 -m http.server 4173
```

打开 http://localhost:4173/。无需安装依赖或构建。

## 发布

这个目录的内容同步到独立公开仓库 `jiangkk/sayrun-site`。GitHub Pages 使用 `main` 分支的根目录，`.nojekyll` 禁用 Jekyll。推送到 main 后，Pages 自动更新。

所有样式、脚本和图标均使用相对地址，适用于 GitHub Pages 项目路径。站点不依赖私有 GitHub 图片或 npm CDN，不包含 CLI 源码、凭证、运行状态或用户任务数据。

# memocap-site

memocap 官网源码。`homepage/` 是当前站点（Vite，英文 `/`、中文 `/zh/`）。`site/` 为历史 Sites 应用，不是现网入口。

组织图与提交要求：[memocap-docs/docs/repos.md](https://github.com/memocap-ai/memocap-docs/blob/main/docs/repos.md)。

## 本仓职责

官网文案、多语言、品牌与预览页。改本仓**不应**触发 CLI / API / 桌面客户端发版。

现网由 `memocap-server` 的 **Deploy Web** 检出本仓 `homepage/`，编进 `memocap-web`（develop `127.0.0.1:8087`）。**不再**编进 API 二进制。

## 与其他仓库

| 仓 | 关系 |
|---|---|
| `memocap-server` | Deploy Web 构建本仓 homepage + server 仓 `admin-ui` |
| `memocap-docs` | 产品叙事 `docs/story.md` |
| 其余 | 无编译依赖 |

登录入口相对路径 `/dashboard`（与 API 同源域名，nginx 分流）。

## 使用

```bash
git clone git@github.com:memocap-ai/memocap-site.git
cd homepage
npm ci
npm test
npm run build   # → ../site/dist/client/
```

详见 [homepage/README.md](homepage/README.md)。发 develop 官网：在 `memocap-server` 跑 workflow **Deploy Web**（`site_ref` 默认 `main`）。

## 发布

打 `v*` 触发 **Release**：本仓 GitHub Release，并 dispatch `memocap-server` **Deploy Web**（prod）。仓库 secret：`SERVER_DEPLOY_TOKEN`（对 `memocap-server` 有 `actions:write` 的 PAT）。也可在 server 仓手动 Deploy Web。

## 提交要求

- i18n 键集 en/zh 必须一致（`npm test`）
- 不把 API 或 CLI 源码拷进本仓
- 其余见 [docs/repos.md](https://github.com/memocap-ai/memocap-docs/blob/main/docs/repos.md)

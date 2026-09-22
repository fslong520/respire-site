# 1memory 官网首页

源码在本目录。`npm run build` 产物写入 `../site/dist/client/`。现网由 `1memory-server` 的 **Deploy Web** 编进 `1memory-web` nginx 镜像，**不再**编进 API 二进制。

登录入口使用相对路径 `/dashboard`，dev 与生产同源。

## 多语言

支持英文（默认）与中文。**英文出在站点根 `/`，中文出在 `/zh/`**——`1memory-web` nginx
按目录提供静态页，前端按 `location.pathname` 选定词条集，
两处必须一致（`src/i18n/index.js` 是唯一判据来源）。

| 位置 | 作用 |
| --- | --- |
| `src/i18n/en.js` `zh.js` | 页面词条，两侧键集必须完全一致 |
| `src/i18n/index.js` | 语言前缀解析、词条选取、浏览器偏好判断 |
| `scripts/preview-i18n.mjs` | 由中文预览产物生成英文版（对照表 `i18n/preview.en.json`） |
| `tests/i18n.test.mjs` | 键集一致、无空词条、英文不含中文、URL 策略、预览对照表覆盖 |

`npm run build` 单次构建产出全部语言：根 `index.html` 为英文，`zh/index.html` 为中文，
哈希资源（`assets/*`）各语言共用。各语言 HTML 只有 `lang` / `title` / `description` 不同。

英文站会按浏览器语言给一次中文提示（`sessionStorage` 记录已关闭），**只提示不跳转**——
URL 决定语言，不做自动重定向，以免分享链接与搜索引擎见到非预期语言。

### 新增一种语言

1. 加 `src/i18n/<locale>.js`，键集照抄 `en.js`（测试会校验）。
2. `src/i18n/index.js` 的 `LOCALES` 加该语言。
3. `vite.config.mjs` 的 `LOCALES` 与 `HEAD` 加该语言；Deploy Web 按目录提供 `/<locale>/`。
4. `public/preview/client.<locale>.html` 放该语言的客户端预览（可先用英文版复制）。
5. `npm test` 须全过。

## 客户端交互预览

`public/preview/client.<locale>.html` 是 `client/tree-ui` 的单文件构建产物（内嵌 JS/CSS/Logo），
**不进 Vite 打包**，原样作为静态资源发布，站点以 iframe 引入。

本目录里的中文版是既有产物，且已领先 `client/tree-ui` 源码若干版，故不重构建，只做文本对照替换：
`i18n/preview.en.json` 是「中文原文 → 英文」对照表（键为解码后的文本，可写真实换行与引号），
`npm run build:preview` 据此生成英文版。产物替换后自动做 JS 语法校验，语法不过即失败。

```bash
npm run build:preview          # 生成 public/preview/client.en.html
npm run build:preview -- --extract   # 列出缺译文本（写 .tmp-preview-missing.json）
```

改预览文案：改 `i18n/preview.en.json` 后重跑 `build:preview`。若将来改用 `client/tree-ui`
源码重建预览，须同步核对两处：`.dock button` 的文本（站点靠它做标签联动）与预览里多出的
「治理」档与日记视图。

## 开发与校验

```bash
npm ci
npm run dev                    # 本地开发（默认语言由 URL 决定，/zh/ 看中文）
npm test                       # 含 tests/i18n.test.mjs
npm run build                  # 产出 site/dist/client/{index.html, zh/index.html, assets/*, preview/*}
```

构建后须把 `site/dist/client/` 的变更一并提交——镜像构建期从仓库读该目录（`service/Dockerfile`）。

## 六语言官网设计稿

两个独立可运行的设计版本，皆不参与当前 React 官网构建、不覆盖 `site/dist/client/`：

### V2：紧凑版（沿用现有设计语言）

`prototypes/multilingual-v2/` 保存新版完整静态前端：默认英文，支持中文、西班牙语、法语、韩语和日语，沿用官网八个主要模块与柔和阴影样式。中文不显示英文主标题副本。

安装说明、源码结构、公开入口配置和验证限制见 [设计稿 README](prototypes/multilingual-v2/README.md) 与 [验证记录](prototypes/multilingual-v2/VERIFICATION.md)。

```bash
python3 -m http.server 4183 --bind 127.0.0.1 --directory homepage/prototypes/multilingual-v2
# 打开 http://127.0.0.1:4183/
```

编辑模板、翻译或资源后，运行 `python3 homepage/prototypes/multilingual-v2/build.py` 重新生成默认英文入口和单文件版。

### V3：Lumina 风格（另立视觉系统）

完整静态源码位于 [`prototypes/lumina-v3/`](prototypes/lumina-v3/README.md)。新版采用悬浮深色导航、暖橙强调色、大字排版、错层记忆卡片与深浅交替的展示区，保留六语文案和客户端交互预览。

```bash
python3 -m http.server 4184 --bind 127.0.0.1 --directory homepage/prototypes/lumina-v3
# 打开 http://127.0.0.1:4184/
```

修改后运行 `python3 homepage/prototypes/lumina-v3/build.py`，生成默认英文入口与内嵌资源的单文件版。默认英文，可切换中文、西班牙语、法语、韩语和日语。已知限制与验收记录见 [`VERIFICATION.md`](prototypes/lumina-v3/VERIFICATION.md)。

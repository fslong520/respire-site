# memocap homepage v2

保留 memocap.ai 的原有八个主要模块、灰白底色、品牌标志、柔和阴影和交互客户端预览。新文案映射到原结构，避免九个独立长屏。

## 预览

无需 npm 依赖或构建框架。在本目录运行：

```sh
python3 -m http.server 4182 --bind 127.0.0.1
```

打开 http://127.0.0.1:4182/ 。`standalone.html` 为内嵌 CSS、JavaScript、SVG 和客户端预览的单文件版本，也可通过此服务打开。

## 语言

默认 English，可切换中文、Español、Français、한국어、日本語。`?lang=zh|es|fr|ko|ja` 保持选定语言；无参数默认英文。中文首屏不显示 “Switch AI. Keep Memory.” 英文副标题。

官网标题、正文、按钮、无障碍标签、反馈及安装提示词均提供六语。品牌口号、协议/技术缩写保留。嵌入的官方客户端演示保留中、英文界面，示例记忆维持原内容；其余四种语言使用英文客户端演示，并在预览下方明确说明。

## 文件

- `index.template.html`：中文结构与文案源。
- `translations.tsv`：六语言文案，列顺序为 zh / en / es / fr / ko / ja，以 `|` 分隔。
- `prompts.js`：六语安装提示词。
- `assets/official.css`、`assets/logo.svg`：沿用官网视觉基础与品牌资源。
- `styles.css`：新文案、紧凑布局、响应式和焦点样式。
- `main.js`：预览模式、全屏、安全面板、复制、弹窗、下载选择等交互。
- `i18n.js`：语言切换、URL 语言状态。
- `config.js`：正式公开链接配置。
- `preview/`：官方中、英文客户端交互演示快照，作为展示用途。
- `build.py`：生成英文默认 `index.html`、`locales.js` 和 `standalone.html`。

修改文案或资源后运行：

```sh
python3 build.py
```

## 正式入口配置

`config.js` 中 `github`、`benchmark`、`docs` 暂为 `null`，遵照当前需求，点击显示入口待开放提示。正式上线前填入真实 HTTPS 地址，再运行构建。下载使用官方 Releases 的 latest/download 地址，客户端在演示中不会安装软件。

## 页面结构

1. 首屏：换 AI，不换记忆。
2. 客户端预览：Tree / Sync / Install 与全屏体验。
3. 产品介绍：跨 Agent 保持记忆连续。
4. 使用方法：记住、想起、接续、修改；Benchmark 为展开内容。
5. 隐私与安全：本地优先、加密同步、开放源码，使用同一面板切换。
6. 控制权：修改、更新、删除、导出，保留 FAQ 结构。
7. AI 安装：本地化提示词与 CLI 命令。
8. 手动下载：Mac / Linux 及架构选择。

## 范围与来源

本交付为静态官网前端，不含后台、真实同步或加密实现。密码算法与安全文案来自用户指定内容，本任务未审计后端；Benchmark 展示测试方向，未伪造测试成绩。Apache 2.0 为用户确认的开源发布计划。核对时 npm `@memocap/cli` 0.2.44 元数据仍写 MIT，实际开源发布时需由项目统一仓库 LICENSE、包元数据及官网表述。

设计资源和客户端预览来源： https://memocap.ai/ 、 https://memocap.ai/preview/client.zh.html 、 https://memocap.ai/preview/client.en.html ，2026-09-20 获取。未对既有嵌入预览资源重新声明许可证。

交付未发布到生产网站。单文件版已通过 HTTP 实测；file:// 双击场景未做浏览器验收。

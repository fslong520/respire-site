# 1Memory 官网 · V3 Lumina 风格版

独立的完整静态前端版本。旧版 V2 文件与 GitHub PR #170 保持不变。

## 启动

需要 Python 3，无 npm 依赖。

```sh
python3 -m http.server 4184 --bind 127.0.0.1
```

在本目录运行后，打开 http://127.0.0.1:4184/ 。`standalone.html` 内嵌全部样式、脚本、品牌 SVG 和客户端预览，可独立分发；建议通过本地 HTTP 服务查看。

## 设计

参考 https://www.lumina-design.co/ 的深色悬浮导航、黑白大字、暖橙强调色、细线几何背景及错层画面，重新编写整页样式。页面采用原创记忆卡片图形，不使用参考站的商业作品图片、品牌标志或网站源码。

- 首屏：两行主标题、安装入口、可点击记忆卡片。
- 产品展示：深色展示区，保留 Tree / Sync / Install 真实交互演示与全屏。
- 产品介绍与使用方法：大标题、细线列表、关联图及 Benchmark 展开项。
- 隐私与安全：深色面板，本地、加密、开源三个可切换主题。
- 控制权、安装与下载：保留原内容与功能，统一新视觉。
- 页脚：暖橙底色、大字品牌与安装入口。

主体仍为八个模块，原九组文案映射到这些模块。动效仅用于首屏入场与悬停反馈，支持 prefers-reduced-motion，内容不依赖动画可见。

## 六种语言

默认英文；可切换中文、西班牙语、法语、韩语、日语。语言通过 `?lang=zh|es|fr|ko|ja` 保持，页面不会根据浏览器语言自动跳转。中文首屏不显示 “Switch AI. Keep Memory.” 英文副标题。

官网正文、按钮、反馈、无障碍标签、安装提示词提供六语。技术缩写与品牌口号保留。内嵌官方客户端演示提供中英文界面，其他语言使用英文演示并有说明，示例记忆沿用原内容。

## 源码结构

- `index.template.html`：中文结构和文案源。
- `translations.tsv`：六语文案，列顺序 zh / en / es / fr / ko / ja，以 `|` 分隔。
- `styles.css`：完整新版样式，独立于旧版 CSS。
- `motion.js`：首屏入场动效，尊重减少动态效果设置。
- `main.js`：卡片跳转、预览模式与全屏、面板、复制、弹窗、下载选择。
- `i18n.js`、`locales.js`：运行时语言切换及生成的词条。
- `prompts.js`：六语安装提示词。
- `config.js`：公开入口配置。
- `assets/`：1Memory 官方标志；official.css 仅保留来源副本，新版不加载。
- `preview/`：原官方客户端中英文演示快照。
- `build.py`：生成默认英文首页、词条和单文件版本。

修改源文件后运行：

```sh
python3 build.py
```

然后使用 `index.html` 或 `standalone.html`。不要只修改生成文件。

## 正式链接与发布范围

GitHub、Benchmark、Docs 按用户确认暂设为 `null`，点击显示待开放弹窗。填入正式 HTTPS 地址后重新构建即可。下载链接使用官方 Releases，页面不会自动安装软件。

本目录是独立设计交付，不参与现有 React 官网构建，也不替换线上官网。V2 保留在独立分支与 PR #170；部署时选择本目录作为静态网站目录即可。

## 内容与技术边界

此交付是官网静态前端，不含后台或真实同步服务。加密算法说明采用用户提供文案，本次未审计加密实现；Benchmark 仅展示测试方向，不包含虚构成绩。Apache 2.0 采用已确认的开源发布计划；此前 npm 元数据仍标 MIT，项目正式发布时需统一许可证元数据。

客户端演示和 1Memory 标志来源： https://1memory.ai/ 、 https://1memory.ai/preview/client.zh.html 、 https://1memory.ai/preview/client.en.html 。这些资源沿用原许可证；本交付不替它们重新声明许可。

浏览器验证范围与已知限制见 `VERIFICATION.md`。

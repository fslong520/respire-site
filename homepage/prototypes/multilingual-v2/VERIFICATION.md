# 验证记录

2026-09-20，Codex 内置浏览器，通过本地 HTTP 服务验收。

- 首页默认英文；六种语言切换后标题、正文与提示词更新；中文 URL 刷新保持语言。
- 中文首屏不含 Switch AI. Keep Memory. 副标题；英文主标题保留。
- 页面维持 8 个主要 section，用户九组文案均在相应模块中。
- 390px 逐一检查六语，document scrollWidth 等于 viewport width；320px 法语边界检查通过；1280px 英文桌面无横向溢出。
- 产品预览 Sync 实际切换；Install 与全屏打开、关闭通过。
- 安全面板点击、左右方向键切换通过。
- Benchmark 折叠展开通过；空 GitHub 地址显示待开放弹窗，Escape 关闭通过。
- 手机菜单打开与 Escape 关闭通过。
- Linux ARM64 RPM 选择后下载 href 指向对应官方安装包；未实际下载或安装客户端。
- 提示词复制操作显示成功反馈；自动化剪贴板读取未取得文本，未把提示反馈等同于系统剪贴板内容校验。代码包含 Clipboard API 失败后的手动选中复制弹窗，该异常路径未强制触发测试。
- standalone.html 通过 HTTP 加载成功，内嵌客户端渲染通过。
- main.js、i18n.js、prompts.js 通过 Node 语法检查。
- 预览初始化改为有界动画帧重试，避免依赖跨文档 MutationObserver。内置浏览器在读取 srcdoc 预览时仍记录 observe 非 Node 错误；隔离掉交付 HTML 中所有 MutationObserver 后仍复现，尚未确认其来源。预览内容、语言切换及全屏功能实测正常，不将控制台描述为零错误。

未验证：生产发布、第三方账户登录、安装包执行、后端加密与同步、Benchmark 成绩、file:// 下的浏览器权限差异。

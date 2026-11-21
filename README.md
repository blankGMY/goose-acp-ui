# Goose 网页控制台（acp-ui 定制版）

把跑在树莓派上的 [Goose](https://github.com/aaif-goose/goose) 智能体，变成手机和电脑浏览器里都能用的控制台：同一个智能体、同一批会话，桌面端开的会话在手机上接着聊，反过来也一样。

本仓库是 [formulahendry/acp-ui](https://github.com/formulahendry/acp-ui) v0.1.16 的 fork（MIT，见 `LICENSE`），针对「Goose 以 `goose serve` 跑在树莓派上、经自写网关对外服务」这个场景做了系统改造。

## 架构

```
浏览器（手机 / 电脑）
   │  HTTPS（Cloudflare Tunnel）或 HTTP（Tailscale 内网）
   ▼
goose-web 网关（gateway/goose-web-proxy.py，纯 Python 标准库）
   ├─ 登录门：密码即 goose-serve 密钥，网关校验后发 30 天 cookie
   ├─ 托管本前端的静态构建（dist-web）
   ├─ /acp：WebSocket 中继到 goose-serve，密钥由网关在服务端注入
   └─ /api：管理接口（扩展 / 配方 / 定时 / GPT 订阅额度），直接操作 Pi 上的 Goose 文件
   ▼
goose-serve（Goose 本体，ACP 协议）── 扩展：Windows-MCP（操作电脑）、GitHub 等
```

## 与原版的差异

按合入顺序，每条都注明了落点文件，方便对照原版阅读：

1. **网关默认接入**：web 构建在没有本地配置时，默认注入一个同源的 `Goose (Pi)` agent（地址按当前页面域名计算），用户打开页面即可连接，不必手动添加。`src/lib/host/index.ts`
2. **会话自动同步**：原版只显示本客户端建过的会话；现在连接后会调 `session/list` 把服务端全部会话（含 Goose 桌面端建的）合并进列表。`src/stores/session.ts`、`src/lib/acp-bridge.ts`
3. **配置项选择器**：Goose 没有实现 ACP 的 `session/set_model`，模型切换走它自己的 `configOptions`（`session/set_config_option`）。新增通用选择器组件，顶栏可切模型 / 服务商 / 思考强度。`src/components/ConfigOptionPicker.vue`
4. **视觉改版**：petrol 汽油青 + 瓷白主题（浅色瓷白底、深色分层 petrol 灰），消息列限宽 880px 居中、回复去卡片底色、输入框改悬浮卡片；登录页在网关里同步重做。`src/App.vue`、`src/components/ChatView.vue`、`gateway/goose-web-proxy.py`
5. **Hermes 式布局**：左侧栏改为导航栏（会话 / 扩展 / 配方 / 定时 / 设置）；会话按工作目录分组成「项目」并带搜索；聊天底部加状态栏，实时显示状态、模型、上下文用量与费用（数据来自智能体的 `usage_update` 推送）。`src/App.vue`、`src/components/SessionList.vue`、`src/components/ChatView.vue`
6. **聊天补齐**：图片附件（点选 / 粘贴 / 拖拽，ACP image 内容块）、消息一键复制、会话导出为 Markdown、会话重命名（本地标题覆盖层，不会被服务端自动标题冲掉）。`src/components/ChatView.vue`、`src/components/SessionList.vue`、`src/stores/session.ts`
15. **会话加载提速 + 微信式布局 + 消息编辑（2026-11-20）**：点开会话慢的根因是三段串行等待——初始化、一次会话列表同步、整段历史回放全部完成后才置连接状态，用户只能盯着欢迎页。现改为初始化一完成就进入会话（`isConnected/currentSession` 提前置位，新增 `isLoadingHistory` 状态），历史回放流式灌入聊天页、顶部有「正在加载历史…」提示，会话列表同步改到加载完成后不阻塞地跑；渲染侧只先渲染最近 80 条（顶部按钮可展开全部）、Markdown 渲染加记忆化缓存、消息行加 `content-visibility: auto` 跳过屏外渲染。布局改微信式：消息区改为居中 880px 列（容器 `padding-inline` 实现），用户消息靠右（气泡、最宽 85%）、智能体输出靠左全宽。用户消息头加编辑按钮：把原文与图片召回输入框修改后重发——Goose 会话是只追加的（服务端不支持改写/分叉），原消息保留在历史里。其后按反馈微调：用户消息头改为「你」左对齐、复制/编辑右对齐（与助手同构，靠 `.copy-btn` 的 `margin-left: auto` 推挤）；聊天页状态栏加扩展开关面板（`src/components/ExtensionsPanel.vue`，与扩展页同一网关接口、改动对新会话生效，和桌面端改配置的语义一致）。`src/stores/session.ts`、`src/components/ChatView.vue`、`src/lib/i18n.ts` 的 `chat.editMessage/loadingHistory/showEarlier` 词条。
14. **GPT 订阅额度显示（2026-11-20）**：Goose 只上报每个会话的 token 与费用，不报订阅额度；网关新增 `GET /api/codex-usage`，用 Pi 上 Goose 自己的 Codex 登录令牌在服务端调用 `chatgpt.com/backend-api/wham/usage`（走本地 Mihomo 代理，2 分钟缓存），只把套餐名和 5 小时/周两个窗口的已用百分比返回给浏览器，令牌不出 Pi；状态栏费用旁显示改为：发送按钮左侧显示两行小字「GPT 5h x% / 周 y%」，悬停看重置时间，每 5 分钟轮询一次、每轮对话结束后再刷新一次，接口失败（令牌失效等）时悄悄隐藏。实测：Plus 套餐，5 小时窗口 0%（当日 07:11 已重置）、周窗口 13%。`gateway/goose-web-proxy.py` 的 codex 段、`src/lib/gateway.ts`、`src/components/ChatView.vue`、`src/lib/i18n.ts` 的 `chat.gptQuota*` 词条。
13. **管理页滚动加固 + 构建标记（2026-11-20）**：管理页（扩展/配方/定时/技能）共用的 `.page-panel` 自带滚动（`flex:1 + min-height:0 + overflow-y:auto`，落点 `src/App.vue`）——该修复部署后用户仍反馈手机上滑不动，逐项核对部署产物确认规则已生效，遂再加固：`.app-container` 高度改 `100vh` 后备 + `100dvh`（手机浏览器 100vh 含地址栏后方区域、内层滚动又不触发地址栏收起，底部会够不着）、flex 链 `.main-area`/`.main-content` 补 `min-height:0`、面板加 `-webkit-overflow-scrolling: touch` 与 `overscroll-behavior: contain`；同时侧栏导航下方加一行构建时间小字（`vite.config.ts` 注入 `VITE_BUILD_TIME`，按 Asia/Shanghai 显示），手机上若还停在旧缓存页面，一眼可辨。
12. **布局与排序调整（2026-11-20）**：侧栏的 agent 区（选择器/工作目录/会话 MCP/断开）移入设置页顶部的「连接」区（经 `<slot />` 注入，状态仍由 App 持有），侧栏只留一个新建会话快捷按钮（未连接时点它打开设置、已连接时直接新建）；会话列表按当前工作目录过滤（`SessionList` 的 `cwd-filter` prop，目录为空时不过滤，过滤后为空有专门提示）；聊天框的附件/链接按钮从输入行移到状态栏左侧，输入框整行归文本框；GPT（chatgpt_codex）的模型下拉在补齐后按版本号从新到旧排序（`session.ts` 的 `sortModelOptions`，分组选项组内组间都排）。
11. **全面优化轮（2026-11-20，体检报告见 `AUDIT-2026-11-20.md`）**：补齐主题缺失变量（`--bg-dialog`/`--bg-input`/`--text-danger`/`--status-*` 等，含深色值），权限弹窗等处不再用浅色兜底，深色模式不再漏白；聊天自动滚底改为「贴底才跟随」+ 回到底部悬浮按钮；Markdown 渲染加 DOMPurify 消毒；全站补 `:focus-visible` 焦点环；原生 `confirm`/`prompt` 全部换成自建对话框（`src/components/AppDialog.vue` + `src/lib/useDialog.ts`）；双语补全（设置页、流量监控、零散硬编码文案）；管理页与设置页改懒加载分包；标题/图标换成 Goose 自有（`public/favicon.svg`）；emoji 图标换成内联 SVG（`src/components/Icon.vue`）；删除死代码 `ToolCallCard.vue`；登录页密码框改 `autocomplete="current-password"`。
10. **技能管理页**：侧栏新增「技能」页，可查看、编辑、新建、删除智能体的技能（技能是 Pi 上 `~/.agents/skills/<名称>/SKILL.md`，Goose 自带的 `goose skills` 命令只有 list、桌面端页面也只能看）。网关新增 `/api/skills` 系列接口（列表 / 读内容 / 保存 / 新建 / 删除，保存前校验 frontmatter 必须含 name 与 description，内置技能只列出、不可改删）。`src/components/SkillsPage.vue`、`gateway/goose-web-proxy.py` 的 skills 段。
9. **补齐 GPT 最新模型**：Goose 1.60 内置的 ChatGPT Codex 模型清单只到 GPT-5.6，但服务端接受账号有权使用的任意模型 id（已实测）。当会话服务商为 chatgpt_codex 时，前端把账号 Codex 目录里的最新模型（GPT-6.2 Sol/Astra、6.1 Sol/Terra、GPT-6 系列、GPT-Reserve）追加进模型选择器（自动去重，Goose 将来内置后自动失效）。`src/stores/session.ts` 的 `augmentConfigOptions`。
8. **中英双语 + Hermes 式底部控制条**：界面支持中/英切换（侧栏右上角按钮，选择会记住；词条在 `src/lib/i18n.ts`，覆盖导航、聊天、会话列表与三个管理页）；模型 / 服务商 / 思考强度 / 模式选择器从顶栏移进聊天框下方的状态栏（与状态点、上下文用量、费用同排），菜单改为向上弹出。`src/components/ChatView.vue`、三个 Picker 组件的 `dropUp` 属性。
7. **管理页（桌面端功能对齐）**：扩展页（开关 / 添加 / 删除，改 `~/.config/goose/config.yaml`，内置扩展只能关不能删）、配方页（列表 / 新建，经 `goose recipe validate` 校验 / 运行）、定时页（增删与立即运行，走 `goose schedule` CLI）。前端在 `src/components/{Extensions,Recipes,Schedules}Page.vue` 与 `src/lib/gateway.ts`，服务端在网关的 `/api` 一节。注意：扩展改动对**新建会话**生效；定时任务在添加时会把配方**快照**一份，之后改配方不影响已有定时。

## 构建与部署

```bash
npm install
npm run build:web        # 产物在 dist-web/
```

把 `dist-web/` 的内容放到网关的 `WEB_ROOT`（默认 `~/acp-ui-web-patched`），重启网关即可。网关的运行只需要 Python 3（管理接口额外需要 PyYAML）：

```bash
python3 gateway/goose-web-proxy.py   # 监听 8083
```

环境变量 `GOOSE_WEB_UPSTREAM_ORIGIN`：网关连 goose-serve 时出示的 Origin，必须与 `goose serve --allowed-origin` 里的一项**完全一致**，否则握手会被拒（桌面端同理，它的 Origin 是 `file://`，也要在允许列表里）。

## 阅读指引

- `src/stores/session.ts`：会话状态的中心。ACP 通知在这里分发（消息、工具调用、配置项、用量、标题同步都在这）。
- `src/lib/acp-bridge.ts`：ACP 协议的桥，JSON-RPC over WebSocket。
- `src/lib/host/index.ts`：web / 桌面两种宿主的配置加载差异，补丁 1 在这里。
- `src/lib/gateway.ts`：管理接口的客户端，三个管理页共用。
- `gateway/goose-web-proxy.py`：单文件网关，登录门、静态托管、WebSocket 中继、管理接口四部分，文件内有分段注释。

## 说明

- `src-tauri/` 是原版的桌面 / 移动壳，本 fork 只使用 web 构建，未做改动；其中图标等二进制文件未随本次快照上传，需要时用普通 git 补齐即可。
- 密钥纪律：goose-serve 的密钥只存在 Pi 上与网关进程内，不进任何网页与客户端配置；管理接口不返回扩展的 Authorization 等秘密值。

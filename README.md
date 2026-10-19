# dsh-mobile-remote-control

> 📱 DeepSeek Harness 移动端远程控制插件 — 在桌面端点开「手机远控」扫码，用手机浏览器查看和控制真实会话：任务列表、流式消息、发送消息、打断、模型切换、审批转发、提问应答、图片上传、用量统计。无云端中继，配对 token 即时轮换。

在 DeepSeek Harness（DSH）里点开「手机远控」，用手机扫码，就能查看并操作桌面端正在运行的真实会话：任务列表、历史消息、流式输出、发送消息、打断、切换模型、本轮文件改动与 diff。

- **进程内服务**：插件作为 DSH Host 插件运行在 DSH 进程内，直接调用真实 Host 服务，不是独立后端，也不是演示壳。
- **无云端依赖**：手机与电脑之间不经过任何第三方服务器；直连局域网，或走你自己的 VPN（如 Tailscale）端到端加密隧道。不需要公网 IP、域名或托管服务。
- **真实数据**：会话、消息、模型、文件改动全部来自 DSH Host；仓库内不包含任何硬编码的假会话、假 diff 或假套餐。

**能力分类**：集成与连接（Integration & Connection） · **许可证**：MIT · **平台**：Windows 桌面端

**环境要求**

| 项 | 要求 |
|---|---|
| DeepSeek Harness | 桌面端 0.2.1-rc.2 或更高（已在 0.2.1-rc.2 实测） |
| 操作系统 | Windows（沙箱/权限相关代码针对 win32） |
| Node.js | 24.x（仓库 CI 使用 Node 24；仅源码部署需要） |
| 手机 | 任意现代浏览器（iOS Safari / Android Chrome / 微信内置浏览器） |

## 安装命令

在终端中执行（`--profile` 换成你的 DSH profile 名，桌面端通常为 `desktop`）：

    # 已发布 npm 包时（本包尚未发布到 npm，见下方说明）
    dsh plugin --profile desktop add dsh-mobile-remote-control

    # 直接从 GitHub 源码安装（当前可用）
    dsh plugin --profile desktop add github:JUEMING-006/dsh-mobile-remote-control

装好后**完全退出并重启 DeepSeek Harness**，左侧边栏账号行会出现「手机远控」图标。

> **npm 发布状态**：本包尚未发布到 npm，因此 DSH 内置「插件中心」暂时搜不到它（插件中心只展示能用 npm 一键安装的包）。当前请使用上面的 `github:` 源码安装命令，或在 DSH 界面里用「插件 → 添加插件」粘贴仓库地址。包发布到 npm 后，第一条命令即可直接使用。

## 快速开始

**第 1 步 · 安装插件**（三选一，见下方「安装」章节）

**第 2 步 · 完全退出并重启 DeepSeek Harness**

必须**完全退出进程**（不是关窗口、不是刷新页面），插件才会加载。

**第 3 步 · 打开配对入口**

重启后，左侧边栏左下角账号行（头像 + 用户名）右侧会出现**手机图标**。点它打开「移动端远程控制」弹窗。

**第 4 步 · 手机连接**

用手机相机扫描弹窗中的二维码，或点「复制链接」把地址发到手机浏览器打开。

连接成功后弹窗状态会变成「已连接 N 台」，手机端即可看到任务列表。

## 架构

    ┌──────────────────────── Windows / 局域网或 VPN ────────────────────────┐
    │                                                                        │
    │  手机浏览器                                                            │
    │  http://<电脑IP>:5288x/?token=…                                        │
    │      │  HTTP REST + WebSocket /ws（X-Remote-Token 鉴权）               │
    │      ▼                                                                 │
    │  ┌──────────────────────── DeepSeek Harness 桌面进程 ───────────────┐  │
    │  │  dsh-mobile-remote-control Host 插件                              │  │
    │  │  ├─ HostBridge          sessionController / workspaceRegistry     │  │
    │  │  │                      / workspaceChanges / ctx 事件             │  │
    │  │  ├─ ApprovalBridge      approval/request 转发（prepend 优先）       │  │
    │  │  ├─ QuestionsBridge     user-questions/request 转发               │  │
    │  │  ├─ RemoteControlServer 0.0.0.0:52880…（占用则顺延）             │  │
    │  │  │                      ├─ 手机端静态资源 + /api/* + /ws          │  │
    │  │  │                      └─ /api/desktop/*（仅 loopback）          │  │
    │  │  └─ client 插件          侧边栏账号行「手机远控」按钮 + 扫码弹窗   │  │
    │  │                          127.0.0.1:52880… 探测并轮询状态          │  │
    │  └──────────────────────────────────────────────────────────────────┘  │
    │                                                                        │
    └────────────────────────────────────────────────────────────────────────┘

数据流：桌面端 client 插件调用 `/api/desktop/state` 拿到二维码与配对链接 → 手机扫码后用 token 访问移动端 API / WS → HostBridge 把请求转发到 DSH 真实服务，并把 `api-session/status`、`agent/assistant-stream`、`session/event` 等实时事件规范化为 WebSocket 消息推给手机。

### 目录

| 路径 | 作用 |
|---|---|
| `src/index.mjs` | Host 插件入口：创建 HostBridge 与 RemoteControlServer，注册生命周期 |
| `src/server/host-bridge.mjs` | 真实 Host 服务桥接（会话列表/历史/实时/发送/打断/模型/改动/搜索/新建/图片上传） |
| `src/server/http-server.mjs` | 局域网 HTTP + WebSocket + 仅 loopback 的桌面配对 API |
| `src/server/protocol.mjs` | DSH 原始事件 → 移动端消息/事件模型的规范化 |
| `src/server/ws-hub.mjs` | `/ws` 协议、订阅管理、设备计数、token 校验 |
| `src/server/approval-bridge.mjs` | 工具审批转发（`approval/request` waterfall 抢占） |
| `src/server/questions-bridge.mjs` | 模型提问转发（`user-questions/request` 批量完整答案校验） |
| `src/server/network-helper.mjs` | 网卡探测（默认路由/私有网段/Tailscale CGNAT 优先）与随机 token |
| `src/server/mock-host.mjs` | 独立运行时的 mock 数据源（明确标注，仅供 UI 联调） |
| `src/web/` | 手机端 H5（任务列表、会话、模型设置） |
| `client/index.js` | 桌面端 DSH Client 插件：账号行入口 + 扫码弹窗 |
| `client/preview.html` | 弹窗静态预览页（无 DSH 环境下的视觉核对） |
| `icon.svg` | 插件图标；`package.json` 的 `icon` 字段与市场索引都会用到 |
| `locale/en.json`、`locale/zh.json` | 插件显示元数据（title/description）；DSH 经 `<pkg>/locale/*.json` 读取 |
| `market/index.json`、`market/icon.svg` | 自建插件市场索引（format 1，相对 icon），托管到 GitHub Pages 后供 Discover 添加 |
| `scripts/deploy.mjs` | 把插件文件同步到 DSH Desktop profile 的部署脚本（目标目录取自包名） |
| `scripts/rename-package.mjs` | 发布前一键改名（包名/client id/bundle patch/mock/测试/文档 + npm pack 校验） |
| `scripts/gen-market-index.mjs` | 生成 `market/index.json`（git source 自动填 40 位 commit，或 `--source=npm`） |
| `.github/workflows/test.yml` | CI：windows-latest + Node 24，跑全部测试 |
| `.github/workflows/release.yml` | 推 `v*` tag 时校验版本并 `npm publish`（NPM_TOKEN） |
| `test/verify-server.mjs` | HTTP / WS / 鉴权 / 桌面 API 集成验证 |
| `test/host-bridge.test.mjs` | HostBridge 映射与规范化单元测试 |
| `test/network-helper.test.mjs` | 网卡探测性能回归（同步阻塞防护） |
| `test/e2e/` | 第二实例端到端验证脚本 |

## 功能

### 手机端（src/web/）

- **任务列表**：真实工作区与任务；只保留非子代理、未归档的会话；显示标题、所属工作区、运行状态、按本地时区分组的相对时间。
- **会话**：分页加载历史；实时流式输出（文本与思考过程）；用户消息与助手消息；本轮文件改动卡（真实 +N -M，点击展开 diff）。
- **离线缓存与降级**：局域网 HTTP 不满足 Service Worker 的安全上下文要求（实测 `navigator.serviceWorker` 为 undefined），改用 localStorage 缓存任务列表与模型目录——冷启动或断网时先渲染上次内容并显示「当前离线」横幅，联网后自动刷新。
- **新消息提醒**：上滑离开底部时，新消息累计到「回到底部」按钮上（如 `↓ 3`）。
- **本轮交付物**：会话里展示 DSH 的 `deliverables/presented` 文件清单（文件名 + 说明），注明文件保存在电脑端。
- **微信内置浏览器适配**：检测到 MicroMessenger 时不再重复渲染页内标题（微信顶栏已显示会话标题），页内改显示工作区，标题自动去掉 `D:\...` 路径前缀。
- **会话用量条**：会话页顶部显示真实 token 统计（输入 / 输出 / 缓存命中率）与上下文占用环，数据来自 DSH 的 `tokenUsage` / `contextPressure` 投影。
- **账户余额（需登录）**：设置页显示 DeepSeek 账号余额与赠送额度；未登录时如实提示，绝不显示假数字。
- **插件清单（只读）**：设置页列出当前 DSH 已加载的 Loader 插件、启用状态，并标出本插件。
- **图片上传**：点击 `+` 可拍照或从相册选图，带缩略图预览，发送后以图片消息进入会话（10MB 上限，PNG/JPEG/WebP/GIF，服务端校验 magic number）。
- **模型提问应答**：模型调用 `ask_user_question` 时手机弹出问答卡（支持单选/多选/自由输入，可一次多题），必须答齐才提交；90 秒未答自动交回电脑端。
- **工具调用审批（仅 ask 权限模式）**：会话触发提权工具时，手机端弹出审批卡（工具名 + 原因 + 倒计时），可「允许一次」或「拒绝」；40 秒未响应自动交回电脑端，绝不卡死会话。完全权限（danger-full-access）下 Host 不产生审批，界面会如实显示。
- **回合过程折叠（对齐 DSH 桌面端）**：已结束的回合默认折叠成一行「已完成，用时 X分Y秒」（中止显示「已停止」、失败显示「处理失败」），只保留最终回答；点开折叠行后按步骤摘要展示过程，再点摘要行可展开该步骤的原始工具卡与思考过程。回合结束（turn-end）自动折叠，运行中的回合不显示折叠行。
- **发送与打断**：输入框发送消息（`POST /api/sessions/:id/prompt`），运行中可打断（cancel）。
- **模型切换与模型设置**：读取真实模型目录（`sessionController.modelCatalog()`），按 provider 分组选择，立即用于当前会话；显示加载失败的 provider 信息。
- **搜索与新建会话**：跨会话搜索、选择工作区新建任务。
- **密钥脱敏**：会话正文中的 `sk-…` / `api_key=…` / `Bearer …` 自动打码显示。
- 断线时显示重连提示并自动重连，重连后恢复当前会话订阅。

### 桌面端扫码弹窗（client/index.js）

入口位于**左侧边栏左下角账号行**（头像 + 用户名）右侧的手机图标，点击打开弹窗：

1. 标题行：图标 +「移动端远程控制」+ 副标题。
2. 内嵌「手机扫码连接」卡：说明文案 → 状态行（等待手机连接 / 状态胶囊 / 停止按钮）→「无法扫码？」行（刷新二维码 / 复制链接）→ 白底二维码。
3. 状态胶囊的五个真实状态：**加载中 / 已就绪 / 已连接 N 台 / 已停止 / 连接失败**。圆点颜色只是状态提示，不代表任何本地伪造结果。
4. 底部「连接方式」切换条：多网卡时列出可用入口（局域网 / Tailscale / 热点），点一下即可切换配对地址与二维码。
5. 数据全部来自桌面配对 API，2 秒轮询一次；弹窗关闭后停止轮询。

真实行为：

- **停止**：`POST /api/desktop/stop`，后台断开所有手机连接并拒绝新连接；界面按返回的 `state` 渲染「已停止」，不会只改本地状态。
- **刷新二维码**：`POST /api/desktop/refresh`，后台重新探测 IP、轮换 token、踢掉旧手机连接并重新生成二维码。
- **复制链接**：复制后台返回的真实 `pairingUrl`；剪贴板权限被拒时回退到 `execCommand`，仍失败则展示可手动选择的链接。
- **在浏览器中打开配对页**：用 `pairingUrl` 新开浏览器窗口；无法打开时给出明确提示。
- **自动跟随网络变化**：打开/关闭 Tailscale 或切换网络后，主配对地址与二维码 2 秒内自动更新（token 不变、已连接手机不受影响），无需手动刷新。
- **请求失败**：显示错误态（红色「连接失败」胶囊 + 原因 + 重试），并提供「在浏览器中打开配对页」回退；绝不把失败显示成成功。
- **mock 提示**：后台以 mock 模式运行时，弹窗内会显示「mock 模式：数据仅用于 UI 联调，不代表真实会话」。

视觉使用 DSH 深色主题（背景 `#1b1d24`、边框 `#2d3139`、正文 `#e2e8f0`、次要文字 `#828c9e`），图标全部为内联 SVG（stroke 1.7），不使用 emoji。`client/preview.html` 与组件使用同一份样式，可直接用浏览器打开核对。

### 桌面配对 API（仅 loopback）

| 方法与路径 | 说明 |
|---|---|
| `GET /api/health` | 公开健康检查，返回 ok / version / mode / startedAt / state；桌面端用 body.mode 识别本插件服务 |
| `GET /api/desktop/state` | state（ready / stopped）/ ready / lanIp / port / pairingUrl / altUrls / candidates / qrDataUrl / deviceCount / version / protocol / mode |
| `POST /api/desktop/refresh` | 重新探测 IP、轮换 token、踢掉旧连接、生成新二维码，返回完整 state |
| `POST /api/desktop/use-ip` | 手动指定配对网卡（body `{ip}`；空字符串恢复自动）。只接受本机真实网卡地址，token 不变、已连接手机不受影响 |
| `POST /api/desktop/stop` | 断开所有手机端连接并停止接受新连接，返回 state（state 为 stopped） |

- 这些接口只接受来自 `127.0.0.1` / `::1` 的请求，局域网来源返回 `403 {error:'loopback only'}`。
- 响应带 `Access-Control-Allow-Origin: *` 与 `Cache-Control: no-store`，桌面端可直接 fetch。
- 桌面端在 52880–52889 内依次探测：`GET /api/health` 返回 200 且存在 mode（host / mock）即命中，再读取 `/api/desktop/state`。
- 停止后再次调用 `/api/desktop/refresh` 会恢复为 ready。

### 手机端 API / WS

- REST：`/api/bootstrap`、`/api/sessions`、`/api/sessions/:id`、`/api/sessions/:id/history`、`/api/sessions/:id/changes[/:seq[/:index]]`、`/api/sessions/:id/attachment/:attachmentId`、`/api/search`、`POST /api/sessions`、`POST /api/sessions/:id/prompt`、`/cancel`、`/model`、`/upload`。
- WebSocket：`/ws?token=…`；客户端发送 hello / list / open / close / history / prompt / cancel / model / models / changes / diff / search / create / rename / ping；服务端推送 hello / list / opened / history / event / models / changes / diff / search / created / session-meta / ack / error / pong，event.kind 包含 message / message-update / stream / stream-start / status / title / model / changes / todo / turn-end。

## 安全边界

1. **随机 token 鉴权**：手机端请求必须携带配对 URL 中的 token（query 参数、X-Remote-Token 头或 Authorization: Bearer）。token 为 256-bit 随机值（`crypto.randomBytes(32)`），刷新二维码时轮换，旧 token 立即失效。校验使用常量时间比较（`timingSafeEqual`）。
2. **桌面接口仅本机**：`/api/desktop/*` 只接受 loopback 请求，避免把带 token 的配对链接泄露给局域网。注意：本机任何进程都可以调用这些 loopback 接口，插件没有对「本机其他程序」再做额外鉴权。
3. **无 TLS，依赖链路加密**：服务监听在 0.0.0.0 的明文 HTTP 上。在可信局域网内使用无妨；跨网络（校园网、公网）时**务必走加密隧道**（见「网络与连接」），不要在公共 Wi-Fi 或通过路由器端口映射/内网穿透直接暴露。
4. **API 密钥不经过手机端**：所有模型请求由电脑端 Host 发起，手机端只发送文本与图片凭据，DeepSeek API key 从不传输到手机、也不经过任何中间节点。
5. **停止即拒绝**：桌面端停止后，手机 API 返回 `403 {error:'stopped'}`，WebSocket 连接被关闭（4001）；只有再次刷新二维码（或重启 DSH）才能重新配对。
6. **无云端**：插件不向任何外部服务器发送会话内容。使用 Tailscale 等 VPN 时，数据在你自己账号的设备间传输，且为端到端加密。

## 网络与连接

### 同一局域网（最简单）

手机和电脑连同一个 Wi-Fi 或热点即可。服务默认监听 52880，被占用时依次尝试 52881–52889。首次运行需要允许 Windows 防火墙的入站连接。

### 校园网 / AP 隔离（连不上时的排查）

很多校园网、访客网络、公司 Wi-Fi 开启了 **AP 隔离（客户端隔离）**：同一 Wi-Fi 下的设备互相不可见，所以手机扫二维码后打不开。

**判断方法**：在电脑上执行 `arp -a`，如果只看到网关地址、看不到手机，基本就是 AP 隔离。

**三个解决方案**：

| 方案 | 做法 | 特点 |
|---|---|---|
| **电脑开热点**（推荐） | Windows 设置 → 网络和 Internet → 移动热点 → 打开；手机连这个热点 | 零安装、零延迟，流量完全不经过校园网设备，隐私最干净 |
| **Tailscale**（跨网通用） | 电脑和手机都装 Tailscale 并登录同一账号；插件会自动识别 100.x 地址并切换二维码 | 同一账号下任意网络都能互连；P2P 直连或端到端加密中继，不经过第三方服务器明文 |
| **修复网络隔离** | 联系网络中心解除 AP 隔离 | 不可控，通常不现实 |

### Tailscale 使用要点

1. 电脑与手机各装一份 [Tailscale](https://tailscale.com)，用同一账号登录（免费档足够）。
2. 插件会自动检测 `100.64.0.0/10`（Tailscale 使用的 CGNAT 段）网卡，**优先**把它作为配对地址；面板底部的「连接方式」也能手动切换。手机端 Tailscale 掉线时面板会提示「Tailscale 已断开」。
3. **避免干扰其它 VPN**：让 Tailscale 只负责 100.x 内部互通，不接管全局流量与 DNS：

   ```bash
   tailscale set --exit-node=            # 不使用出口节点
   tailscale set --accept-routes=false   # 不接受其它节点的路由
   tailscale set --accept-dns=false      # 不改写 DNS
   ```

   改完后默认路由与 DNS 保持由系统/原有代理管理，Tailscale 只做内网互连。若你的代理软件（Clash 等）使用 TUN 模式，确认它的规则里有 `IP-CIDR,100.64.0.0/10,DIRECT`。

4. 手机端建议开启 Tailscale 的常驻/VPN Always-on，否则息屏后会被系统回收导致掉线。

### 多网卡与自动切换

- 局域网 IP 通过默认路由和网卡类型评分探测；同时使用 VPN、多网卡或虚拟网卡时，插件按「Tailscale > 默认路由网卡 > WLAN > 以太网」排序，并在面板提供手动切换。
- 打开或关闭 VPN 后，主配对地址会在 2 秒内自动更新，无需手动刷新二维码。
- 备用入口：面板上其他网卡的配对链接也可用，手机接入对应网络后即可访问。
- 服务只监听 IPv4（`0.0.0.0`），纯 IPv6 局域网未适配。
- 多实例同时运行时，桌面弹窗按 52880–52889 顺序连接第一个响应 `/api/health` 的实例；如果需要确保连的是当前实例，请只保留一个 DSH 桌面实例。

## 使用方法

### 日常操作

| 操作 | 方式 |
|---|---|
| 查看任务列表 | 打开配对链接即进入首页，显示所有工作区与任务 |
| 查看会话 | 点任务卡进入，默认停在最新消息；上滑加载更早历史 |
| 发送消息 | 输入框输入后发送；运行中可点停止打断 |
| 切换模型 | 会话页顶部模型名 → 选择 provider 与模型 |
| 审批工具 | 会话触发提权工具时弹出审批卡，选「允许一次」或「拒绝」 |
| 回答提问 | 模型提问时弹出问答卡，选选项或输入自由文本后提交 |
| 上传图片 | 输入框左侧 `+` → 拍照或从相册选择 → 预览确认 → 发送 |
| 查看用量 | 会话页顶部展示 token 统计与上下文占用 |
| 账户余额 | 设置页 → 账户（需已登录） |
| 新建任务 | 任务列表页 → 选择工作区 → 新建 |

### 添加到手机主屏幕（可选）

手机端是一个标准 Web 应用（含 `manifest.webmanifest`）。在手机浏览器中打开配对页后，选择「添加到主屏幕」，即可得到独立图标、全屏无地址栏的使用体验，接近原生 App。

> 注意：iOS Safari 在**非 HTTPS** 下不会启用完整 PWA 能力（如 Service Worker 离线缓存）。本项目已用 localStorage 兜底离线首屏，因此不依赖 Service Worker。

### 桌面端弹窗

- 点账号行手机图标打开/关闭；`Esc` 也可关闭。
- 二维码 2 秒轮询刷新状态；关闭弹窗即停止轮询。
- 「停止」会断开所有手机连接；再次「刷新二维码」恢复。

## 注意事项

### 必须做的

1. **完全重启 DSH**：改代码/换插件版本后必须**完全退出进程**（不是关窗口、不是刷新页面），否则仍运行旧代码。
2. **不要暴露到公网**：不要在路由器上做端口映射，也不要用内网穿透工具直接把 52880 端口映射出去。跨网访问请用 Tailscale 等加密隧道。
3. **仅在可信网络使用**：插件是明文 HTTP + token 鉴权，同一网络中若有人能嗅探到配对链接，就能访问你的会话。
4. **不用时点「停止」**：临时不用时，点弹窗「停止」即可断开所有手机连接并拒绝新连接。

### 常见问题

| 现象 | 原因与处理 |
|---|---|
| 弹窗显示「连接失败」 | 插件未加载或版本过旧；确认已完全重启 DSH，并检查端口 52880–52889 是否被占用 |
| 弹窗显示「已找到桌面端服务但接口不可用」 | 该实例卡住或版本过旧；若同机有多个实例，弹窗会自动尝试其它端口 |
| 手机扫码后打不开 | 典型 AP 隔离，见「网络与连接」；或手机与电脑不在同一网络 |
| 面板地址与电脑实际 IP 不符 | 已自动跟随；若仍不符点「刷新二维码」，或用「连接方式」手动切换 |
| 审批卡不出现 | 仅 `ask` 权限模式会触发审批；`danger-full-access` 下 Host 不产生审批 |
| 手机端操作后电脑没反应 | 检查手机端 WebSocket 是否已重连（页面顶部会显示重连提示） |
| Tailscale 下延迟高（数百 ms） | 走的是 DERP 中继；两台设备在同一网络时通常会自动打洞直连，延迟降到个位数 |
| 装了 Tailscale 后其它软件登录失败 | Tailscale 接管了全局路由/DNS，按「Tailscale 使用要点」第 3 条调整 |

### 性能说明

插件在网卡探测上做了严格约束：**不在请求路径上同步执行外部命令**。早期版本曾因为同步调用 `powershell.exe` 查询默认路由（每次 0.6–1.5 秒）而阻塞事件循环，导致桌面弹窗报「接口不可用」。现在改为后台异步查询 + 缓存 + 模块加载预热，状态接口冷启动约 16ms、稳态 3–4ms。回归测试见 `test/network-helper.test.mjs`。

## 安装

DSH 没有官方插件市场：市场里的每个索引源都由作者自建并托管（本项目索引文件是仓库里的 `market/index.json`，已用官方 `@deepseek-ai/dsh-plugin-market-index` 校验通过）。

### 方式 A：从 Git 仓库安装（最简单）

在 DSH Web 的 **插件 → 添加插件** 输入框中粘贴本仓库地址：

    https://github.com/JUEMING-006/dsh-mobile-remote-control

DSH 会把它当作 git 仓库克隆安装。

> **注意**：「添加插件」接受的是**包名 / git 仓库地址 / 本地 tarball 路径**。市场索引 URL（`…/market/index.json`）要填在 **插件市场 → Discover → 添加索引源**，两者是不同的入口。

### 方式 B：插件市场索引

1. 打开 DSH Web 侧边栏 **插件**，在 Experimental plugins 的 **More** 页开启 **Custom plugin markets**（对应可选 bundle `@deepseek-ai/dsh-experimental-plugin-market-bundle`；开启后出现 **Discover** 标签）。
2. **插件 → Discover → 添加索引源**，填入市场索引 URL：

       https://JUEMING-006.github.io/dsh-mobile-remote-control/market/index.json

3. 在 Discover 里搜索「移动端远程控制」或 Mobile Remote Control → **安装** → 确认 trust 提示 → **立即启用**。
4. **完全退出并重启 DeepSeek Harness**。

索引里的 `icon` 用相对路径 `./icon.svg`（相对索引 URL 解析），因此托管索引时必须同时提供 `market/icon.svg`。

### 方式 C：本地 tarball

1. 在本仓库执行 `npm install` 后打包：

       npm pack

   得到 `dsh-mobile-remote-control-<version>.tgz`。
2. DSH Web → 插件 → **添加插件** → 在 package 输入框粘贴 tarball 的**绝对路径**（例如 `D:\dist\dsh-mobile-remote-control-2.0.0.tgz`）→ **安装** → **立即启用**。
3. **完全退出并重启 DeepSeek Harness**。

### 方式 D：从源码部署（本仓库开发）

要求：Windows + DeepSeek Harness 桌面端；本仓库依赖 qrcode 与 ws。

    npm install            # 安装依赖
    npm run deploy:dry     # 预览将要同步的文件（不写盘）
    npm run deploy         # 同步到 %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-mobile-remote-control

`scripts/deploy.mjs` 的目标目录取自 `package.json` 的 `name`，只同步 `src/`、`client/`、`package.json`、`cordis.patch.yml`、`README.md`；幂等、不删除目标目录中的其它文件。若目标目录是指向本仓库的 junction/symlink，脚本会跳过拷贝（仓库即产物）。同步完成后**完全退出并重启 DeepSeek Harness**。

如果 PowerShell 因执行策略禁止运行 `npm.ps1`（报 UnauthorizedAccess / about_Execution_Policies），可直接执行 `node scripts/deploy.mjs` 或 `node scripts/deploy.mjs --dry-run`，效果相同。

首次安装（profile 里还没有本插件）还需要：

1. 在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 数组末尾加入 `dsh-mobile-remote-control`。
2. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾加入：

   ```yaml
   - id: remote-control
     name: "dsh-mobile-remote-control"
     config:
       enabled: true
   ```

3. 执行 `npm run deploy`（目标目录不存在时会自动创建），然后完全重启 DeepSeek Harness。
4. 点开左下角账号行的手机图标，用手机相机扫描弹窗中的二维码；也可以点「复制链接」把配对地址粘贴到手机浏览器打开。

## 从旧包名迁移

<!-- rename-script:keep-start -->
> 本仓库**已完成改名**：包名、client 插件 id、bundle patch 都已是 <code>dsh-mobile-remote-control</code>
> （npm 上 <code>dsh-remote-control</code> 被他人占用）。如果你之前装过旧名版本（<code>dsh-remote-control</code>），
> 按下面步骤迁移到新名；全新安装无需迁移。

1. **完全退出 DeepSeek Harness**（不是关窗口），并备份 <code>%USERPROFILE%\.dsh\profiles\desktop\</code>（<code>package.json</code>、<code>cordis.patch.yml</code>）。
2. 在 profile 的 <code>package.json</code> 中：
   - <code>dependencies</code> 里的 <code>dsh-remote-control</code> 依赖删掉，换成 <code>dsh-mobile-remote-control</code>（来自 npm 的版本，或新的本地 <code>file:...tgz</code>）；
   - <code>dsh.profile.bundles</code> 里的 <code>"dsh-remote-control"</code> 替换为 <code>"dsh-mobile-remote-control"</code>。
3. 在 profile 的 <code>cordis.patch.yml</code> 中，把用户 patch 里插入过的 <code>name: "dsh-remote-control"</code> 改成 <code>name: "dsh-mobile-remote-control"</code>（那一行的 <code>id: remote-control</code> 可以保留，id 不是包名）。注意这是 profile 的 patch 文件，不是插件包内的 <code>cordis.patch.yml</code>。
4. 删除旧的 <code>%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-remote-control\</code> 目录（先卸载旧包；不要新旧两个目录并存，否则 loader 可能加载到旧代码）。
5. 重新安装新包（插件市场 / tarball / 或本仓库改名后 <code>node scripts/deploy.mjs</code>，目标目录会自动变成 <code>node_modules\dsh-mobile-remote-control</code>）。
6. **完全退出并重启 DeepSeek Harness**；左侧边栏账号行出现「手机远控」图标即迁移成功。改名后必须完全重启，不能只刷新页面。
7. 手机端需要重新扫码配对（token 属于每次启动/刷新生成的，与包名无关）；旧浏览器 localStorage 里的配对链接缓存键（<code>dsh-remote-control:last-pairing-url</code>）不再使用，无数据风险。
<!-- rename-script:keep-end -->

## 发布（维护者）

本仓库已执行过改名脚本。如果将来需要再改包名，可重新运行（幂等，默认目标 `dsh-mobile-remote-control`，一条命令改完包名、client 插件 id、bundle patch、mock 数据、测试注释与文档，并跑 `npm pack` 校验文件清单）：

    node scripts/rename-package.mjs --dry-run   # 预览
    node scripts/rename-package.mjs             # 执行改名

然后用市场索引生成器生成 `market/index.json`（git 仓库就绪后自动填 git source + 40 位 commit；没有 git 时用 `--source=npm`）：

    node scripts/gen-market-index.mjs --source=npm --index-url=https://<user>.github.io/<repo>/market/index.json

GitHub Actions：`.github/workflows/test.yml` 在 push/PR 跑全部测试；`.github/workflows/release.yml` 在推 `v*` tag 时校验 tag 与版本一致并 `npm publish`（需要仓库 secret `NPM_TOKEN`）。完整发布清单、官方校验器输出、npm pack 清单与迁移核对见仓库内 `.verify/design/release.md`（内部文档，不随包发布）。

## 开发与测试

    npm install
    npm test               # 服务器协议/鉴权/桌面 API + HostBridge/审批/提问/图片上传/网卡性能
    npm start              # 独立运行 mock 模式（不连接 DSH Host，仅用于 UI 联调）

测试套件共 76 项断言/用例：

| 测试文件 | 覆盖 |
|---|---|
| `test/verify-server.mjs` | 26 项：HTTP、WS、鉴权、桌面 API、审批/提问能力字段、账户/插件/用量契约 |
| `test/host-bridge.test.mjs` | 10 项：会话过滤、消息规范化、实时跟随、命令转发、用量回归 |
| `test/approval-bridge.test.mjs` | 13 项：审批抢占、超时、中止、释放、重复应答 |
| `test/questions-bridge.test.mjs` | 12 项：批量完整性校验、部分答案拒绝、自由文本 |
| `test/image-upload.test.mjs` | 10 项：媒体类型、base64 规范、magic number、大小上限、收据生命周期 |
| `test/network-helper.test.mjs` | 5 项：首调不阻塞、缓存命中、Tailscale 优先、token 熵 |

- 独立运行时 `/api/health` 返回 mode 为 mock，桌面弹窗与移动端界面会明确标注 mock，绝不冒充真实数据。
- 视觉核对：直接用浏览器打开 `client/preview.html`；它使用与组件完全相同的 CSS，包含完整弹窗与状态胶囊示例。
- 端到端验证：`test/e2e/` 用第二个 DSH 实例（独立 profile 与端口）加载真实 `~/.dsh` 数据，验证列表、历史、发送、打断、切换模型与文件改动。

## 已知限制

- 手机端暂不支持 HEIC 图片（iPhone 默认格式），上传前需转为 JPEG/PNG；也不支持通用文件上传（仅图片链路走通）。
- 大文件 diff、二进制文件与超长历史有分页/截断策略，界面会明确显示占位或「加载更多」。
- 桌面弹窗依赖插件已部署且 DSH 已重启；未部署或版本过旧时会显示「连接失败」错误态与部署提示，而不是假成功。
- 停止配对后手机端被拒绝访问；需要刷新二维码或重启 DSH 才能恢复。
- DSH Host 服务不可用（例如模型目录加载失败、会话已归档）时，对应功能会显示错误信息而不是编造数据。
- mock 模式只用于 UI 联调，不能当作真实远程控制使用。
- 回合精确用时来自 Host 端 turns 计时：在当前运行中的旧版 Host 进程里会用消息时间估算（可能略有偏差），完全重启 DSH 后即为精确值。
- 图片上传收据保存在内存中（TTL 10 分钟、发送成功后单次删除），插件进程重启后失效；手机端每次发送都会重新上传，无需用户干预。
- 服务只监听 IPv4，纯 IPv6 网络未适配。

## 许可证

本项目使用 **MIT License**，全文见 [LICENSE](LICENSE)。

    MIT License

    Copyright (c) 2026 JUEMING-006

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

### 第三方依赖

本项目的运行时依赖均为 MIT 许可，可自由分发：

| 依赖 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| [qrcode](https://github.com/soldair/node-qrcode) | ^1.5.4 | MIT | 生成配对二维码 |
| [ws](https://github.com/websockets/ws) | ^8.18.0 | MIT | WebSocket 服务端 |

DeepSeek Harness 本体及其 `@deepseek-ai/*` 包不在本项目中分发，使用需遵循其自身许可条款。

### 贡献与使用声明

- 本项目为个人开发的开源插件，与 DeepSeek 官方无隶属关系；"DeepSeek"、"DeepSeek Harness" 等名称与商标归其各自所有者。
- 允许在遵守 MIT 许可条款的前提下自由使用、修改、分发，包括商业用途。分发时请保留 `LICENSE` 文件与版权声明。
- 请在**你自己拥有或已获授权**的设备与网络上使用本插件。用于连接他人设备、绕过网络访问控制或侵犯他人隐私的行为，由使用者自行承担全部责任。
- 插件会读取并转发 DSH 会话内容（含你授予的本地文件改动信息）到你配对的那台手机；请确保配对设备可信，不用时及时点「停止」。

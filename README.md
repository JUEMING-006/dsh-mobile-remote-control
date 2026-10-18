# dsh-mobile-remote-control

> 📱 DeepSeek Harness 移动端远程控制插件 — 桌面端点开「手机远控」扫码，用同一局域网内的手机浏览器查看和控制真实会话：任务列表、流式消息、发送消息、打断、模型切换、审批转发、提问应答、图片上传、用量统计。无云端中继，配对 token 即时轮换。

在 DeepSeek Harness（DSH）里点开「手机远控」，用手机扫码，就能在同一局域网内查看并操作桌面端正在运行的真实会话：任务列表、历史消息、流式输出、发送消息、打断、切换模型、本轮文件改动与 diff。

- **进程内服务**：插件作为 DSH Host 插件运行在 DSH 进程内，直接调用真实 Host 服务，不是独立后端，也不是演示壳。
- **无云端、无公网**：手机与电脑之间的 HTTP/WS 流量只走局域网；不需要公网 IP、域名、内网穿透或中继服务。
- **真实数据**：会话、消息、模型、文件改动全部来自 DSH Host；仓库内不包含任何硬编码的假会话、假 diff 或假套餐。

## 架构

    ┌──────────────────────── Windows / 同一局域网 ────────────────────────┐
    │                                                                      │
    │  手机浏览器                                                          │
    │  http://<局域网IP>:5288x/?token=…                                    │
    │      │  HTTP REST + WebSocket /ws（X-Remote-Token 鉴权）             │
    │      ▼                                                               │
    │  ┌──────────────────────── DeepSeek Harness 桌面进程 ─────────────┐  │
    │  │  dsh-mobile-remote-control Host 插件                                  │  │
    │  │  ├─ HostBridge          sessionController / workspaceRegistry  │  │
    │  │  │                      / workspaceChanges / ctx 事件          │  │
    │  │  ├─ RemoteControlServer 0.0.0.0:52880…（占用则顺延）           │  │
    │  │  │                      ├─ 手机端静态资源 + /api/* + /ws        │  │
    │  │  │                      └─ /api/desktop/*（仅 loopback）        │  │
    │  │  └─ client 插件         界面右下角「手机远控」悬浮入口 + 扫码弹窗│  │
    │  │                          127.0.0.1:52880… 探测并轮询状态        │  │
    │  └────────────────────────────────────────────────────────────────┘  │
    │                                                                      │
    └──────────────────────────────────────────────────────────────────────┘

数据流：桌面端 client 插件调用 <code>/api/desktop/state</code> 拿到二维码与配对链接 → 手机扫码后用 token 访问移动端 API / WS → HostBridge 把请求转发到 DSH 真实服务，并把 <code>api-session/status</code>、<code>agent/assistant-stream</code>、<code>session/event</code> 等实时事件规范化为 WebSocket 消息推给手机。

### 目录

| 路径 | 作用 |
|---|---|
| <code>src/index.mjs</code> | Host 插件入口：创建 HostBridge 与 RemoteControlServer，注册生命周期 |
| <code>src/server/host-bridge.mjs</code> | 真实 Host 服务桥接（会话列表/历史/实时/发送/打断/模型/改动/搜索/新建） |
| <code>src/server/http-server.mjs</code> | 局域网 HTTP + WebSocket + 仅 loopback 的桌面配对 API |
| <code>src/server/protocol.mjs</code> | DSH 原始事件 → 移动端消息/事件模型的规范化 |
| <code>src/server/ws-hub.mjs</code> | <code>/ws</code> 协议、订阅管理、设备计数、token 校验 |
| <code>src/server/network-helper.mjs</code> | 局域网 IPv4 探测（优先级/默认路由）与随机 token |
| <code>src/server/mock-host.mjs</code> | 独立运行时的 mock 数据源（明确标注，仅供 UI 联调） |
| <code>src/web/</code> | 手机端 H5（任务列表、会话、模型设置） |
| <code>client/index.js</code> | 桌面端 DSH Client 插件：悬浮入口 + 扫码弹窗 |
| <code>client/preview.html</code> | 弹窗静态预览页（无 DSH 环境下的视觉核对） |
| <code>icon.svg</code> | 插件图标；<code>package.json</code> 的 <code>icon</code> 字段与市场索引都会用到 |
| <code>locale/en.json</code>、<code>locale/zh.json</code> | 插件显示元数据（title/description）；DSH 经 <code>&lt;pkg&gt;/locale/*.json</code> 读取 |
| <code>market/index.json</code>、<code>market/icon.svg</code> | 自建插件市场索引（format 1，相对 icon），托管到 GitHub Pages 后供 Discover 添加 |
| <code>scripts/deploy.mjs</code> | 把插件文件同步到 DSH Desktop profile 的部署脚本（目标目录取自包名） |
| <code>scripts/rename-package.mjs</code> | 发布前一键改名（包名/client id/bundle patch/mock/测试/文档 + npm pack 校验） |
| <code>scripts/gen-market-index.mjs</code> | 生成 <code>market/index.json</code>（git source 自动填 40 位 commit，或 <code>--source=npm</code>） |
| <code>.github/workflows/test.yml</code> | CI：windows-latest + Node 24，跑全部测试 |
| <code>.github/workflows/release.yml</code> | 推 <code>v*</code> tag 时校验版本并 <code>npm publish</code>（NPM_TOKEN） |
| <code>test/verify-server.mjs</code> | HTTP / WS / 鉴权 / 桌面 API 集成验证 |
| <code>test/host-bridge.test.mjs</code> | HostBridge 映射与规范化单元测试 |
| <code>test/e2e/</code> | 第二实例端到端验证脚本 |

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
- **回合过程折叠（对齐 DSH 桌面端）**：已结束的回合默认折叠成一行「已完成，用时 X分Y秒」（中止显示「已停止」、失败显示「处理失败」），只保留最终回答；点开折叠行后按步骤摘要展示过程（如「运行了代码并已完成分析」「执行了命令，已读取文件，修改了文件等」），再点摘要行可展开该步骤的原始工具卡与思考过程。回合结束（turn-end）自动折叠，运行中的回合不显示折叠行。
- **发送与打断**：输入框发送消息（<code>POST /api/sessions/:id/prompt</code>），运行中可打断（cancel）。
- **模型切换与模型设置**：读取真实模型目录（<code>sessionController.modelCatalog()</code>），按 provider 分组选择，立即用于当前会话；显示加载失败的 provider 信息。
- **搜索与新建会话**：跨会话搜索、选择工作区新建任务。
- 断线时显示重连提示并自动重连，重连后恢复当前会话订阅。

### 桌面端扫码弹窗（client/index.js）

界面右下角固定一个中性的「手机远控」悬浮胶囊（<code>shell.overlay</code> 槽位，不遮挡内容），点击打开弹窗：

1. 标题行：图标 +「移动端远程控制」+ 副标题。
2. 内嵌「手机扫码连接」卡：说明文案 → 状态行（等待手机连接 / 状态胶囊 / 停止按钮）→「无法扫码？」行（刷新二维码 / 复制链接）→ 白底二维码。
3. 状态胶囊的五个真实状态：**加载中 / 已就绪 / 已连接 N 台 / 已停止 / 连接失败**。圆点颜色只是状态提示，不代表任何本地伪造结果。
4. 数据全部来自桌面配对 API，2 秒轮询一次；弹窗关闭后停止轮询。

真实行为：

- **停止**：<code>POST /api/desktop/stop</code>，后台断开所有手机连接并拒绝新连接；界面按返回的 <code>state</code> 渲染「已停止」，不会只改本地状态。
- **刷新二维码**：<code>POST /api/desktop/refresh</code>，后台重新探测局域网 IP、轮换 token、踢掉旧手机连接并重新生成二维码。
- **复制链接**：复制后台返回的真实 <code>pairingUrl</code>；剪贴板权限被拒时回退到 <code>execCommand</code>，仍失败则展示可手动选择的链接。
- **在浏览器中打开配对页**：用 <code>pairingUrl</code> 新开浏览器窗口；无法打开时给出明确提示。
- **请求失败**：显示错误态（红色「连接失败」胶囊 + 原因 + 重试），并提供「在浏览器中打开配对页」回退（打开上一次成功获取的配对链接）；绝不把失败显示成成功。
- **mock 提示**：后台以 mock 模式运行时，弹窗内会显示「mock 模式：数据仅用于 UI 联调，不代表真实会话」。

视觉使用 DSH 深色主题（背景 <code>#1b1d24</code>、边框 <code>#2d3139</code>、正文 <code>#e2e8f0</code>、次要文字 <code>#828c9e</code>），图标全部为内联 SVG（stroke 1.7），不使用 emoji。<code>client/preview.html</code> 与组件使用同一份样式，可直接用浏览器打开核对。

### 桌面配对 API（仅 loopback）

| 方法与路径 | 说明 |
|---|---|
| <code>GET /api/health</code> | 公开健康检查，返回 ok / version / mode / startedAt / state；桌面端用 body.mode 识别本插件服务 |
| <code>GET /api/desktop/state</code> | state（ready / stopped）/ ready / lanIp / port / pairingUrl / qrDataUrl / deviceCount / version / protocol / mode |
| <code>POST /api/desktop/refresh</code> | 重新探测 IP、轮换 token、踢掉旧连接、生成新二维码，返回完整 state |
| <code>POST /api/desktop/stop</code> | 断开所有手机端连接并停止接受新连接，返回 state（state 为 stopped） |

- 这些接口只接受来自 <code>127.0.0.1</code> / <code>::1</code> 的请求，局域网来源返回 <code>403 {error:'loopback only'}</code>。
- 响应带 <code>Access-Control-Allow-Origin: *</code> 与 <code>Cache-Control: no-store</code>，桌面端可直接 fetch。
- 桌面端在 52880–52889 内依次探测：<code>GET /api/health</code> 返回 200 且存在 mode（host / mock）即命中，再读取 <code>/api/desktop/state</code>。
- 停止后再次调用 <code>/api/desktop/refresh</code> 会恢复为 ready。

### 手机端 API / WS

- REST：<code>/api/bootstrap</code>、<code>/api/sessions</code>、<code>/api/sessions/:id</code>、<code>/api/sessions/:id/history</code>、<code>/api/sessions/:id/changes[/:seq[/:index]]</code>、<code>/api/sessions/:id/attachment/:attachmentId</code>、<code>/api/search</code>、<code>POST /api/sessions</code>、<code>POST /api/sessions/:id/prompt|cancel|model</code>。
- WebSocket：<code>/ws?token=…</code>；客户端发送 hello / list / open / close / history / prompt / cancel / model / models / changes / diff / search / create / rename / ping；服务端推送 hello / list / opened / history / event / models / changes / diff / search / created / session-meta / ack / error / pong，event.kind 包含 message / message-update / stream / stream-start / status / title / model / changes / todo / turn-end。

## 安全边界

1. **局域网 + 一次性 token**：手机端请求必须携带配对 URL 中的 token（query 参数、X-Remote-Token 头或 Authorization: Bearer）。token 为每次启动/刷新时生成的随机值，刷新后旧 token 立即失效。
2. **桌面接口仅本机**：<code>/api/desktop/*</code> 只接受 loopback 请求，避免把带 token 的配对链接泄露给局域网。注意：本机任何进程都可以调用这些 loopback 接口，插件没有对「本机其他程序」再做额外鉴权。
3. **无公网、无中继、无 TLS**：服务监听在 0.0.0.0 的明文 HTTP 上，只应在可信局域网使用；不要在公共 Wi-Fi、访客网络或通过路由器端口映射/内网穿透暴露它。
4. **停止即拒绝**：桌面端停止后，手机 API 返回 <code>403 {error:'stopped'}</code>，WebSocket 连接被关闭（4001）；只有再次刷新二维码（或重启 DSH）才能重新配对。
5. **无云端**：插件不向任何外部服务器发送会话内容；手机与电脑之间是同一局域网内的点对点连接。

## 局域网与网络限制

- 手机和电脑必须在**同一局域网**（同一 Wi-Fi 或同一热点）。开启 AP 隔离/访客网络的 Wi-Fi 通常无法互访。
- 服务默认监听 52880，被占用时依次尝试 52881–52889；首次运行需要允许 Windows 防火墙的入站连接（专用网络）。
- 局域网 IP 通过默认路由和网卡优先级探测；同时使用 VPN、多网卡或虚拟网卡时可能选到错误的地址，点「刷新二维码」会重新探测。
- 手机端是 HTTP 而非 HTTPS，部分浏览器不会把它当作安全上下文；二维码/复制链接来自真实局域网地址，跨网段不可用。
- 服务只监听 IPv4（0.0.0.0），纯 IPv6 局域网未适配。
- 多实例同时运行时，桌面弹窗按 52880–52889 顺序连接第一个响应 <code>/api/health</code> 的实例；如果需要确保连的是当前实例，请只保留一个 DSH 桌面实例。

## 安装

DSH 没有官方插件市场：市场里的每个索引源都由作者自建并托管（本项目索引文件是仓库里的 <code>market/index.json</code>，已用官方 <code>@deepseek-ai/dsh-plugin-market-index</code> 校验通过）。

### 方式 A：插件市场（推荐）

1. 打开 DSH Web 侧边栏 **Plugins**，在 Experimental plugins 的 **More** 页开启 **Custom plugin markets**（对应自带可选 bundle <code>@deepseek-ai/dsh-experimental-plugin-market-bundle</code>；开启后 Plugins 页出现 **Discover** 标签）。
2. **Plugins → Discover → Add index source**，填入本项目的市场索引 URL（发布后为真实地址）：

       https://<你的 GitHub 用户名>.github.io/dsh-mobile-remote-control/market/index.json

3. 在 Discover 里搜索「移动端远程控制」或 Mobile Remote Control → **Install** → 确认 trust 提示 → 安装完成后 **Enable now**。
4. **完全退出并重启 DeepSeek Harness**，界面右下角出现「手机远控」入口。

索引里的 <code>icon</code> 用相对路径 <code>./icon.svg</code>（相对索引 URL 解析），因此托管索引时必须同时提供 <code>market/icon.svg</code>；<code>source</code> 为 <code>{"type":"npm"}</code>，安装目标固定为 <code>dsh-mobile-remote-control@2.0.0</code>（改名前均为发布目标名；维护者细节见下方「发布」章节）。

### 方式 B：本地 tarball（不经过市场）

1. 在本仓库执行 <code>npm install</code> 后打包：

       npm pack

   得到 <code>dsh-mobile-remote-control-2.0.0.tgz</code>（改名发布后为 <code>dsh-mobile-remote-control-2.0.0.tgz</code>）。
2. DSH Web → Plugins → **Add plugin** → 在 package 输入框粘贴 tarball 的**绝对路径**（例如 <code>D:\dist\dsh-mobile-remote-control-2.0.0.tgz</code>）→ **Install** → **Enable now**。
3. **完全退出并重启 DeepSeek Harness**。

也可以手动改 profile（插件管理器会维护自身 lock，手工改完要自己确认）：<code>%USERPROFILE%\.dsh\profiles\desktop\package.json</code> 的 <code>dependencies</code> 加入 <code>"dsh-mobile-remote-control": "file:D:/dist/dsh-mobile-remote-control-2.0.0.tgz"</code>，并把 <code>dsh-mobile-remote-control</code> 加入 <code>dsh.profile.bundles</code>。

### 方式 C：从源码部署（本仓库开发）

要求：Windows + DeepSeek Harness 桌面端；本仓库依赖 qrcode 与 ws。

    npm install            # 安装依赖
    npm run deploy:dry     # 预览将要同步的文件（不写盘）
    npm run deploy         # 同步到 %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-mobile-remote-control

<code>scripts/deploy.mjs</code> 的目标目录取自 <code>package.json</code> 的 <code>name</code>，只同步 <code>src/</code>、<code>client/</code>、<code>package.json</code>、<code>cordis.patch.yml</code>、<code>README.md</code>；幂等、不删除目标目录中的其它文件。同步完成后**完全退出并重启 DeepSeek Harness**（只关窗口不算），右下角会出现「手机远控」入口。

如果 PowerShell 因执行策略禁止运行 npm.ps1（报 UnauthorizedAccess / about_Execution_Policies），可直接执行 <code>node scripts/deploy.mjs</code> 或 <code>node scripts/deploy.mjs --dry-run</code>，效果相同。

首次安装（profile 里还没有本插件）还需要：

1. 在 <code>%USERPROFILE%\.dsh\profiles\desktop\package.json</code> 的 <code>dsh.profile.bundles</code> 数组末尾加入 <code>dsh-mobile-remote-control</code>。
2. 在 <code>%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml</code> 末尾加入：

    - id: remote-control
      name: "dsh-mobile-remote-control"
      config:
        enabled: true

3. 执行 <code>npm run deploy</code>（目标目录不存在时会自动创建），然后完全重启 DeepSeek Harness。
4. 点开右下角「手机远控」，用手机相机扫描弹窗中的二维码；也可以点「复制链接」把配对地址粘贴到手机浏览器打开。

## 从旧包名迁移（发布改名后执行）

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
6. **完全退出并重启 DeepSeek Harness**；右下角「手机远控」出现即迁移成功。改名后必须完全重启，不能只刷新页面。
7. 手机端需要重新扫码配对（token 属于每次启动/刷新生成的，与包名无关）；旧浏览器 localStorage 里的配对链接缓存键（<code>dsh-remote-control:last-pairing-url</code>）不再使用，无数据风险。
<!-- rename-script:keep-end -->

## 发布（维护者）

本仓库已执行过改名脚本。如果将来需要再改包名，可重新运行（幂等，默认目标 <code>dsh-mobile-remote-control</code>，一条命令改完包名、client 插件 id、bundle patch、mock 数据、测试注释与文档，并跑 <code>npm pack</code> 校验文件清单）：

    node scripts/rename-package.mjs --dry-run   # 预览
    node scripts/rename-package.mjs             # 执行改名

然后用市场索引生成器生成 <code>market/index.json</code>（git 仓库就绪后自动填 git source + 40 位 commit；没有 git 时用 <code>--source=npm</code>）：

    node scripts/gen-market-index.mjs --source=npm --index-url=https://<user>.github.io/<repo>/market/index.json

GitHub Actions：<code>.github/workflows/test.yml</code> 在 push/PR 跑全部测试；<code>.github/workflows/release.yml</code> 在推 <code>v*</code> tag 时校验 tag 与版本一致并 <code>npm publish</code>（需要仓库 secret <code>NPM_TOKEN</code>）。完整发布清单、官方校验器输出、npm pack 清单与迁移核对见仓库内 <code>.verify/design/release.md</code>（内部文档，不随包发布）。

## 开发与测试

    npm install
    npm test               # 服务器协议/鉴权/桌面 API + HostBridge 单元测试
    npm start              # 独立运行 mock 模式（不连接 DSH Host，仅用于 UI 联调）

- 独立运行时 <code>/api/health</code> 返回 mode 为 mock，桌面弹窗与移动端界面会明确标注 mock，绝不冒充真实数据。
- 视觉核对：直接用浏览器打开 <code>client/preview.html</code>；它使用与组件完全相同的 CSS，包含完整弹窗与状态胶囊示例。
- 端到端验证：<code>test/e2e/</code> 用第二个 DSH 实例（独立 profile 与端口）加载真实 ~/.dsh 数据，验证列表、历史、发送、打断、切换模型与文件改动。

## 已知限制

- 仅支持同一局域网；不支持公网/中继/HTTPS，也不做屏幕共享。
- 手机端暂不支持上传附件；图片消息只读展示。
- 大文件 diff、二进制文件与超长历史有分页/截断策略，界面会明确显示占位或「加载更多」。
- 桌面弹窗依赖插件已部署且 DSH 已重启；未部署或版本过旧时会显示「连接失败」错误态与部署提示，而不是假成功。
- 停止配对后手机端被拒绝访问；需要刷新二维码或重启 DSH 才能恢复。
- DSH Host 服务不可用（例如模型目录加载失败、会话已归档）时，对应功能会显示错误信息而不是编造数据。
- mock 模式只用于 UI 联调，不能当作真实远程控制使用。
- 回合精确用时来自 Host 端 turns 计时：在当前运行中的旧版 Host 进程里会用消息时间估算（可能略有偏差），完全重启 DSH 后即为精确值。

## License

MIT

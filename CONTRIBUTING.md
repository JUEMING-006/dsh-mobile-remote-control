# 贡献与维护指南

本文件面向**本仓库的维护者与贡献者**。普通用户请阅读 [README.md](README.md)。

## 开发环境

```bash
npm install
```

要求 Node.js 24.x。运行时依赖 `qrcode` 与 `ws`（均 MIT）。

## 测试

```bash
npm test
```

测试套件共 **76 项**断言/用例：

| 测试文件 | 覆盖 |
|---|---|
| `test/verify-server.mjs` | 26 项：HTTP、WS、鉴权、桌面 API、审批/提问能力字段、账户/插件/用量契约 |
| `test/host-bridge.test.mjs` | 10 项：会话过滤、消息规范化、实时跟随、命令转发、用量回归 |
| `test/approval-bridge.test.mjs` | 13 项：审批抢占、超时、中止、释放、重复应答 |
| `test/questions-bridge.test.mjs` | 12 项：批量完整性校验、部分答案拒绝、自由文本 |
| `test/image-upload.test.mjs` | 10 项：媒体类型、base64 规范、magic number、大小上限、收据生命周期 |
| `test/network-helper.test.mjs` | 5 项：首调不阻塞、缓存命中、Tailscale 优先、token 熵 |

其他命令：

```bash
npm start              # 独立运行 mock 模式（不连接 DSH Host，仅用于 UI 联调）
npm run deploy:dry     # 预览将同步到 DSH profile 的文件（不写盘）
npm run deploy         # 同步到 DSH Desktop profile
```

- 独立运行时 `/api/health` 返回 mode 为 mock，桌面弹窗与移动端界面会明确标注 mock，绝不冒充真实数据。
- 视觉核对：直接用浏览器打开 `client/preview.html`；它使用与组件完全相同的 CSS，包含完整弹窗与状态胶囊示例。
- 端到端验证：`test/e2e/` 用第二个 DSH 实例（独立 profile 与端口）加载真实 `~/.dsh` 数据，验证列表、历史、发送、打断、切换模型与文件改动。

## 代码结构约定

- Host 插件入口 `src/index.mjs` 只做装配（创建 HostBridge 与 RemoteControlServer），业务逻辑放 `src/server/`。
- 事件转发必须用 `ctx.on(event, handler, { global: true, prepend: true })`：`prepend` 是必需的，否则 `dsh-api-remotes` 会先抢到 waterfall 并阻塞等待 Web 客户端。
- 可选服务一律用 `ctx.get('serviceName')` 获取，**不要**直接写 `ctx.serviceName` —— 未经 `inject` 声明会抛异常（历史上曾因此让 `/api/sessions/:id` 全面 500）。
- **不要在请求路径上同步执行外部命令**：`execFileSync` 启动 `powershell.exe` 需 0.6–1.5 秒，会阻塞事件循环并让桌面弹窗的 1.2 秒探测超时。改为后台异步 + 缓存 + 模块加载预热（见 `src/server/network-helper.mjs`）。
- 失败必须如实上报：绝不把失败渲染成成功，也不用假数据兜底。

## 发布流程

本仓库已执行过改名脚本。如果将来需要再改包名，可重新运行（幂等，默认目标 `dsh-mobile-remote-control`，一条命令改完包名、client 插件 id、bundle patch、mock 数据、测试注释与文档，并跑 `npm pack` 校验文件清单）：

```bash
node scripts/rename-package.mjs --dry-run   # 预览
node scripts/rename-package.mjs             # 执行改名
```

然后用市场索引生成器生成 `market/index.json`（git 仓库就绪后自动填 git source + 40 位 commit；没有 git 时用 `--source=npm`）：

```bash
node scripts/gen-market-index.mjs --source=npm --index-url=https://<user>.github.io/<repo>/market/index.json
```

GitHub Actions：

- `.github/workflows/test.yml` —— push/PR 时在 windows-latest + Node 24 上跑全部测试。
- `.github/workflows/release.yml` —— 推 `v*` tag 时校验 tag 与 `package.json` 版本一致，然后 `npm publish`（需要仓库 secret `NPM_TOKEN`）。

完整发布清单、官方校验器输出、npm pack 清单与改名迁移核对见仓库内 `.verify/design/release.md`（内部文档，不随包发布）。

## 上架 dsh-plugin.org（社区插件市场）

`dsh-plugin.org` 通过爬虫扫描公开仓库并人工复核收录。收录要求：

- [x] 仓库公开
- [x] 仓库添加 GitHub topic `dsh-plugin`（**爬虫识别的唯一标记**）
- [x] README 包含安装命令，形如 `dsh plugin --profile <name> add <包名>`
- [x] 插件导出 `apply(ctx)` 模块
- [x] 仓库根目录包含 `package.json`

> 只有发布了 **npm 包**才会出现在 DSH 内置「插件中心」；没有 npm 包时站点照常收录，用户可用 `github:<owner>/<repo>` 源码安装。

提交入口：<https://dsh-plugin.org/zh/submit>（含预填 Issue 模板）。

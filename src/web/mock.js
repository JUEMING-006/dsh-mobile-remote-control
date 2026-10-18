/**
 * mock.js — 仅用于本地开发自检（?mock=1）。
 *
 * 该模块在真实运行中永远不会被加载：app.js 只有在 URL 带 mock=1 时才会
 * 动态 import 本文件。这里的数据、WS 协议回放全部为本地构造，不冒充真实
 * Host 数据；真实模式下所有内容来自 HTTP / WS。
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ */
/* 静态数据                                                            */
/* ------------------------------------------------------------------ */

const MODEL_CATALOG = {
  groups: [
    {
      id: 'deepseek-account',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-flash',
          name: 'deepseek-flash',
          description: '快速响应，适合日常修改、代码问答与轻量任务',
          reasoning: {
            efforts: [
              { id: 'low', name: '快速' },
              { id: 'high', name: '深入' },
              { id: 'max', name: '最大' },
            ],
            defaultEffort: 'max',
          },
        },
        {
          id: 'deepseek-pro',
          name: 'deepseek-pro',
          description: '复杂重构与长上下文任务',
          reasoning: {
            efforts: [
              { id: 'low', name: '快速' },
              { id: 'high', name: '深入' },
            ],
            defaultEffort: 'high',
          },
        },
      ],
    },
    {
      id: 'bigmodel-api',
      name: 'BigModel',
      models: [
        { id: 'glm-4.6', name: 'glm-4.6', description: '通用编码模型，128K 上下文' },
        { id: 'glm-4.5-air', name: 'glm-4.5-air', description: '轻量高速，适合批量修改' },
      ],
    },
    {
      id: 'minimax',
      name: 'MiniMax',
      models: [{ id: 'MiniMax-M2', name: 'MiniMax-M2', description: '长上下文推理与工具调用' }],
    },
    {
      id: 'claude',
      name: 'Claude',
      models: [
        {
          id: 'claude-sonnet-4.5',
          name: 'claude-sonnet-4.5',
          description: '深度分析与复杂代码理解',
          reasoning: {
            efforts: [
              { id: 'low', name: '快速' },
              { id: 'high', name: '深入' },
            ],
            defaultEffort: 'low',
          },
        },
      ],
    },
  ],
  default: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  failures: [
    { id: 'opencode', name: 'openCode', message: '未配置 API Key，请在 DSH 设置中补全后重试。' },
    { id: 'xiaomi', name: 'xiaomi', message: '供应商未连接，无法读取模型列表。' },
  ],
};

const WORKSPACES = [
  { id: 'ws-maestro', title: 'MAESTRO', path: 'D:\\MAESTRO', sessionCount: 3 },
  { id: 'ws-teaching', title: '教学材料', path: 'D:\\TEACHING', sessionCount: 1 },
  { id: 'ws-competition', title: '竞赛材料', path: 'D:\\COMPETITION', sessionCount: 1 },
  { id: 'ws-docs', title: '文档规范', path: 'D:\\DOCS', sessionCount: 1 },
  { id: 'ws-remote', title: 'dsh-miniapp', path: 'D:\\Users\\jueming\\Desktop\\dsh-miniapp', sessionCount: 1 },
  { id: 'ws-task', title: '任务', path: 'D:\\', sessionCount: 1 },
];

function buildSessions(now) {
  const mk = (o) => ({
    id: o.id,
    title: o.title,
    workspaceId: o.workspaceId,
    workspaceTitle: o.workspaceTitle,
    workspacePath: o.workspacePath ?? null,
    cwd: o.cwd ?? o.workspacePath ?? null,
    createdAt: now - (o.age ?? DAY),
    updatedAt: now - o.updated,
    running: !!o.running,
    blank: !!o.blank,
    agentAvailable: true,
    turns: o.turns ?? 1,
    steps: o.steps ?? 1,
    model: o.model ?? { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  });

  return [
    mk({
      id: 's-1001',
      title: '多路径 MTU 探测与断线重连核对',
      workspaceId: 'ws-maestro',
      workspaceTitle: 'MAESTRO',
      workspacePath: 'D:\\MAESTRO',
      updated: 12 * MIN,
      running: true,
      turns: 4,
      steps: 9,
      age: 2 * DAY,
    }),
    mk({
      id: 's-1002',
      title: 'PPT 讲稿结构与授课节奏梳理',
      workspaceId: 'ws-teaching',
      workspaceTitle: '教学材料',
      workspacePath: 'D:\\TEACHING',
      updated: 3 * HOUR,
      turns: 2,
      steps: 5,
      age: 3 * DAY,
      model: { provider: 'bigmodel-api', model: 'glm-4.6' },
    }),
    mk({
      id: 's-1003',
      title: '项目软著申请分层与专利分析',
      workspaceId: 'ws-maestro',
      workspaceTitle: 'MAESTRO',
      workspacePath: 'D:\\MAESTRO',
      updated: DAY + 2 * HOUR,
      turns: 6,
      steps: 14,
      age: 4 * DAY,
    }),
    mk({
      id: 's-1004',
      title: 'DeepSeek 多智能体协作插件调研',
      workspaceId: 'ws-remote',
      workspaceTitle: 'dsh-miniapp',
      workspacePath: 'D:\\Users\\jueming\\Desktop\\dsh-miniapp',
      updated: 2 * DAY,
      running: true,
      turns: 2,
      steps: 6,
      age: 5 * DAY,
      model: { provider: 'deepseek-account', model: 'deepseek-pro', reasoningEffort: 'high' },
    }),
    mk({
      id: 's-1005',
      title: '严格参照文档格式重新生成 Word 材料',
      workspaceId: 'ws-docs',
      workspaceTitle: '文档规范',
      workspacePath: 'D:\\DOCS',
      updated: 3 * DAY,
      turns: 3,
      steps: 8,
      age: 6 * DAY,
    }),
    mk({
      id: 's-1006',
      title: '职规赛成长赛道国奖 PPT 方案规划',
      workspaceId: 'ws-competition',
      workspaceTitle: '竞赛材料',
      workspacePath: 'D:\\COMPETITION',
      updated: 8 * DAY,
      turns: 4,
      steps: 11,
      age: 12 * DAY,
      model: { provider: 'claude', model: 'claude-sonnet-4.5' },
    }),
    mk({
      id: 's-1007',
      title: '服务端 WS 协议联调与断线重连验证',
      workspaceId: 'ws-remote',
      workspaceTitle: 'dsh-miniapp',
      workspacePath: 'D:\\Users\\jueming\\Desktop\\dsh-miniapp',
      updated: 9 * DAY,
      turns: 5,
      steps: 13,
      age: 14 * DAY,
    }),
    mk({
      id: 's-1008',
      title: '旧版会话归档与数据清理',
      workspaceId: 'ws-task',
      workspaceTitle: '任务',
      workspacePath: 'D:\\',
      updated: 30 * DAY,
      turns: 1,
      steps: 2,
      age: 40 * DAY,
    }),
    mk({
      id: 's-1009',
      title: '新任务',
      workspaceId: 'ws-maestro',
      workspaceTitle: 'MAESTRO',
      workspacePath: 'D:\\MAESTRO',
      updated: 40 * MIN,
      blank: true,
      turns: 0,
      steps: 0,
      age: 40 * MIN,
    }),
    mk({
      id: 's-1010',
      title: '敏感信息脱敏回归',
      workspaceId: 'ws-remote',
      workspaceTitle: 'dsh-miniapp',
      workspacePath: 'D:\\Users\\jueming\\Desktop\\dsh-miniapp',
      updated: 30 * MIN,
      turns: 1,
      steps: 2,
      age: 2 * HOUR,
    }),
    mk({
      id: 's-1011',
      title: '配置 api_key=sk-proj-9f8e7d6c5b4a3210fedcba9876543210 后一直 401',
      workspaceId: 'ws-remote',
      workspaceTitle: 'dsh-miniapp',
      workspacePath: 'D:\\Users\\jueming\\Desktop\\dsh-miniapp',
      updated: 20 * MIN,
      turns: 1,
      steps: 1,
      age: HOUR,
    }),
    mk({
      id: 's-1012',
      title: '已中止回合回归',
      workspaceId: 'ws-remote',
      workspaceTitle: 'dsh-miniapp',
      workspacePath: 'D:\\Users\\jueming\\Desktop\\dsh-miniapp',
      updated: 15 * MIN,
      turns: 1,
      steps: 3,
      age: HOUR,
    }),
    mk({
      id: 's-1013',
      title: '回合折叠回归',
      workspaceId: 'ws-remote',
      workspaceTitle: 'dsh-miniapp',
      workspacePath: 'D:\\Users\\jueming\\Desktop\\dsh-miniapp',
      updated: 10 * MIN,
      turns: 1,
      steps: 3,
      age: HOUR,
    }),
  ];
}

function message(id, seq, role, time, blocks, extra) {
  return { id, seq, role, time, blocks, ...extra };
}

function buildMainMessages(now) {
  const t = (minAgo) => now - minAgo * MIN;
  return [
    message('m-95', 95, 'user', t(96), [{ type: 'text', text: '继续把 MTU 那段改完，先看当前改动，再跑验证。' }], { turn: 3 }),
    message(
      'm-96',
      96,
      'assistant',
      t(95),
      [
        {
          type: 'reasoning',
          text: '用户要求先确认当前改动再执行修改。先读取 network-helper 的关键函数，确认没有其它文件被误改；随后运行现有的路径 MTU 单测。',
        },
        {
          type: 'tool',
          callId: 'call-read-1',
          name: 'read_file',
          args: '{"path":"src/network-helper.mjs","offset":1,"limit":80}',
          status: 'done',
          output: 'export function resolvePathMtu(localMtu, peerMtu) {\n  const min = Math.min(localMtu, peerMtu);\n  return min < 1691 ? 0 : min;\n}',
        },
        { type: 'text', text: '先确认了改动只涉及 2 个文件，接下来跑一遍基线测试。' },
      ],
      {
        turn: 3,
        step: 1,
        model: { provider: 'deepseek-account', model: 'deepseek-flash' },
      },
    ),
    message(
      'm-97',
      97,
      'assistant',
      t(94),
      [
        {
          type: 'reasoning',
          text: '读取结果确认只有 2 个文件被改动。先跑一遍现有单测确认基线，再把 MTU 比较顺序调整为 peer → local → min，并补边界用例。',
        },
        {
          type: 'tool',
          callId: 'call-exec-1',
          name: 'bash',
          args: '{"command":"node --test test/network-helper.test.mjs"}',
          status: 'done',
          output: 'ok 12 tests passed (0 failed)',
        },
        {
          type: 'tool',
          callId: 'call-patch-1',
          name: 'write',
          args: '{"path":"src/network-helper.mjs","content":"..."}',
          status: 'done',
          output: 'updated src/network-helper.mjs (+18 -4)',
        },
        { type: 'text', text: '已经把 MTU 顺序改成 peer → local → min，并补了边界用例。' },
      ],
      {
        turn: 3,
        step: 2,
        model: { provider: 'deepseek-account', model: 'deepseek-flash' },
      },
    ),
    message(
      'm-98',
      98,
      'assistant',
      t(93),
      [
        {
          type: 'text',
          text: '改动范围确认完毕，当前只有 2 个文件：\n\n- `src/network-helper.mjs`：把 MTU 比较顺序调整为 peer → local → min，去掉硬编码的 1691 下限；\n- `test/network-helper.test.mjs`：补了 1691 与 1500 两组边界用例。\n\n验证结果：`node --test` 12 个用例全部通过。\n\n```js\nconst peerMtu = getPeerMtu(peer);\nconst localMtu = getLocalMtu(iface);\nconst mtu = Math.min(peerMtu, localMtu);\nreturn mtu;\n```\n\n```bash\nnode --test test/network-helper.test.mjs\n# ok 12 tests passed (0 failed)\n```\n\nMTU 部分已经完成，接下来可以核对 WS 断线重连。',
        },
      ],
      {
        turn: 3,
        step: 3,
        model: { provider: 'deepseek-account', model: 'deepseek-flash' },
        usage: { inputTokens: 1842, outputTokens: 536, cacheReadTokens: 1024 },
      },
    ),
    message(
      'm-99',
      99,
      'user',
      t(22),
      [{ type: 'text', text: '把断线重连的逻辑也核对一遍，重点看重连后有没有重新订阅会话。' }],
      { turn: 4 },
    ),
    message(
      'm-100',
      100,
      'assistant',
      t(21),
      [
        {
          type: 'reasoning',
          text: '检查 WS 客户端重连流程：指数退避 1s~8s；重连成功后的 onopen 里需要重新发送 hello / list / open 三个订阅消息。确认没有在 close 回调里重复创建连接导致连接风暴。',
        },
        {
          type: 'text',
          text: '## 断线重连核对结果\n\n重连逻辑基本正确，但重连成功后没有重新发送 `open`，导致会话不再接收流式事件。已补上重订阅并做了防抖。\n\n### 结论\n\n1. 退避区间：1s → 2s → 4s → 8s，符合预期；\n2. 重连成功后会依次发送 `hello`、`list`、`open`；\n3. 手动关闭（路由离开）时不再触发自动重连。\n\n| 场景 | 结果 |\n| --- | --- |\n| 网络闪断 2 秒 | 自动恢复并补齐消息 |\n| 电脑端刷新二维码 | 旧连接被踢，显示失效页 |\n| 主动关闭会话 | 不再重连 |\n\n剩余风险：弱网下 `history` 拉取与实时事件可能交叉，需要按 `seq` 去重，目前已在客户端处理。',
        },
      ],
      {
        turn: 4,
        step: 3,
        model: { provider: 'deepseek-account', model: 'deepseek-flash' },
        usage: { inputTokens: 2210, outputTokens: 688, cacheReadTokens: 1536 },
      },
    ),
  ];
}

function buildOlderMessages(now) {
  const t = (minAgo) => now - minAgo * MIN;
  return [
    message('m-91', 91, 'user', t(180), [{ type: 'text', text: '这个项目的入口文件在哪里？' }], { turn: 1 }),
    message('m-92', 92, 'assistant', t(179), [{ type: 'text', text: '入口是 `src/index.mjs`，插件通过 `apply(ctx)` 注入服务并启动 HTTP/WS 服务。' }], { turn: 1 }),
    message('m-93', 93, 'user', t(150), [{ type: 'text', text: '先把移动端页面结构理清楚，其它后面再说。' }], { turn: 2 }),
    message('m-94', 94, 'assistant', t(149), [{ type: 'text', text: '好的，先拆成任务列表、会话、模型设置三个视图，等样式稿确认后再接入真实数据。' }], { turn: 2 }),
  ];
}


function buildChanges() {
  return {
    3: {
      seq: 210,
      summary: {
        turn: 3,
        cwd: 'D:\\MAESTRO',
        files: [
          { path: 'src/network-helper.mjs', display: 'src/network-helper.mjs', added: 18, deleted: 4 },
          { path: 'test/network-helper.test.mjs', display: 'test/network-helper.test.mjs', added: 16, deleted: 3 },
        ],
        total: 2,
        added: 34,
        deleted: 7,
      },
    },
    4: {
      seq: 211,
      summary: {
        turn: 4,
        cwd: 'D:\\MAESTRO',
        files: [
          { path: 'src/web/app.js', display: 'src/web/app.js', added: 96, deleted: 12 },
          { path: 'src/web/app.css', display: 'src/web/app.css', added: 28, deleted: 6 },
          { path: 'src/web/index.html', display: 'src/web/index.html', added: 8, deleted: 3 },
        ],
        total: 3,
        added: 132,
        deleted: 21,
      },
    },
  };
}

function buildDiffs() {
  return {
    '210:0': {
      kind: 'text',
      path: 'src/network-helper.mjs',
      display: 'src/network-helper.mjs',
      before: 'export function resolvePathMtu(localMtu, peerMtu) {\n  const min = Math.min(localMtu, peerMtu);\n  return min < 1691 ? 0 : min;\n}',
      after: 'export function resolvePathMtu(localMtu, peerMtu) {\n  const min = Math.min(localMtu, peerMtu);\n  return min;\n}',
      hunks: [
        {
          oldStart: 12,
          oldLines: 6,
          newStart: 12,
          newLines: 8,
          lines: [
            ' export function resolvePathMtu(localMtu, peerMtu) {',
            '+  const peer = getPeerMtu(peerMtu);',
            '+  const local = getLocalMtu(localMtu);',
            '-  const min = Math.min(localMtu, peerMtu);',
            '-  return min < 1691 ? 0 : min;',
            '+  const min = Math.min(peer, local);',
            '+  return min;',
            ' }',
          ],
        },
      ],
      coarse: false,
    },
    '210:1': {
      kind: 'text',
      path: 'test/network-helper.test.mjs',
      display: 'test/network-helper.test.mjs',
      before: '',
      after: '',
      hunks: [
        {
          oldStart: 4,
          oldLines: 3,
          newStart: 4,
          newLines: 9,
          lines: [
            " import test from 'node:test';",
            '+test("1691 的下界不再被拒绝", () => {',
            '+  assert.equal(resolvePathMtu(1500, 1691), 1500);',
            '+});',
            '+',
            '+test("取 peer/local 较小值", () => {',
            '+  assert.equal(resolvePathMtu(9000, 1500), 1500);',
            '+});',
            ' });',
          ],
        },
      ],
      coarse: false,
    },
    '211:0': {
      kind: 'text',
      path: 'src/web/app.js',
      display: 'src/web/app.js',
      before: '',
      after: '',
      hunks: [
        {
          oldStart: 128,
          oldLines: 6,
          newStart: 128,
          newLines: 12,
          lines: [
            ' function connectWs() {',
            '-  ws = new WebSocket(url);',
            '+  ws = new WebSocket(url);',
            '+  ws.onopen = () => {',
            '+    attempts = 0;',
            '+    setWsState("open");',
            '+    ws.send(JSON.stringify({ type: "hello" }));',
            '+    ws.send(JSON.stringify({ type: "list" }));',
            '+    if (currentSessionId) ws.send(JSON.stringify({ type: "open", sessionId: currentSessionId }));',
            '+  };',
            ' }',
          ],
        },
      ],
      coarse: false,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

function createStore() {
  const now = Date.now();
  const sessions = buildSessions(now);
  const chats = new Map();
  const changes = new Map();
  const diffs = new Map();

  const mainMessages = [...buildOlderMessages(now), ...buildMainMessages(now)];
  chats.set('s-1001', {
    messages: mainMessages,
    hasMore: true,
    running: true,
    nextTurn: 5,
    nextSeq: 105,
    streaming: null,
    streamingTimer: null,
    changes: buildChanges(),
    diffs: buildDiffs(),
    deliverables: [
      { path: '任务报告/2026-10-16_28_中继点专项调查与替代方案.md', description: '中继点专项调查报告（完稿）', turn: 2 },
      { path: '任务报告/README.md', description: '更新索引', turn: 2 },
    ],
    usage: {
      tokens: { input: 18234, output: 5120, cacheRead: 130000, cacheWrite: 0, total: 153354 },
      context: { pressureTokens: 51200, surfaceTokens: 210000, contextWindow: 1000000 },
    },
  });

  const simple = (sid, title) => {
    if (chats.has(sid)) return;
    const msgs = [
      message(sid + '-u1', 1, 'user', now - 2 * HOUR, [{ type: 'text', text: '先看一下`' + title + '`目前做到哪一步了。' }], { turn: 1 }),
      message(
        sid + '-a1',
        2,
        'assistant',
        now - 2 * HOUR + MIN,
        [{ type: 'text', text: '我已经读取了当前工作区的最近改动，主题是`' + title + '`。需要我继续整理一份结论还是直接开始修改？' }],
        { turn: 1, model: { provider: 'deepseek-account', model: 'deepseek-flash' } },
      ),
    ];
    chats.set(sid, { messages: msgs, hasMore: false, running: false, nextTurn: 2, nextSeq: 3, streaming: null, streamingTimer: null, changes: {}, diffs: {} });
  };
  for (const s of sessions) {
    if (!s.blank) simple(s.id, s.title);
  }

  // 脱敏回归样本：用户消息 + 助手正文均包含 sk- / api_key= / Bearer / 正常代码。
  const secretUserText = '帮我检查这两个配置：sk-2cc9bb5a80944ac5afb75400a2ce6c8f31 和 api_key=sk-proj-9f8e7d6c5b4a3210fedcba9876543210，顺便确认 const min = 1691 不会被误改。';
  const secretAssistantText = '已检查：`sk-2cc9bb5a80944ac5afb75400a2ce6c8f31` 与 api_key=sk-proj-9f8e7d6c5b4a3210fedcba9876543210 只做展示级脱敏；Bearer abcdefghijklmnopqrstuvwxyz0123456789 同样处理。普通代码 `const min = 1691` 保持原样。';
  chats.set('s-1010', {
    messages: [
      message('s-1010-u1', 1, 'user', now - 20 * MIN, [{ type: 'text', text: secretUserText }], { turn: 1 }),
      message('s-1010-a1', 2, 'assistant', now - 19 * MIN, [{ type: 'text', text: secretAssistantText }], {
        turn: 1,
        model: { provider: 'deepseek-account', model: 'deepseek-flash' },
      }),
    ],
    hasMore: false,
    running: false,
    nextTurn: 2,
    nextSeq: 3,
    streaming: null,
    streamingTimer: null,
    changes: {},
    diffs: {},
  });


  const collapsedUserText = '帮我检查一下构建流程，最后给一个结论就好。';
  const collapsedCommentary1 = '先读了构建脚本和 package.json，确认入口与依赖。';
  const collapsedCommentary2 = '接着跑了一次构建，并把缺失的清理步骤补进了脚本。';
  const collapsedFinalText = '## 结论\n\n构建流程验证完成：\n\n1. 依赖安装正常；\n2. 构建脚本已补齐清理步骤；\n3. 本地构建耗时约 12 秒。\n\n建议把 npm run build 加入发布前检查。';
  const abortedUserText = '把这个改动继续做完。';
  const abortedCommentary = '已经定位到需要改的文件，先读取内容。';

  chats.set('s-1013', {
    messages: [
      message('s-1013-u1', 1, 'user', now - 9 * MIN, [{ type: 'text', text: collapsedUserText }], { turn: 1 }),
      message('s-1013-a1', 2, 'assistant', now - 8 * MIN, [
        { type: 'reasoning', text: '先确认项目结构与构建入口，避免漏掉脚本依赖。' },
        { type: 'tool', callId: 'fold-read-1', name: 'read_file', args: '{"path":"package.json"}', status: 'done', output: '{"scripts":{"build":"node scripts/build.mjs"}}' },
        { type: 'text', text: collapsedCommentary1 },
      ], { turn: 1, step: 1, model: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
      message('s-1013-a2', 3, 'assistant', now - 7 * MIN, [
        { type: 'reasoning', text: '跑一次现有构建，再把缺失的清理步骤补进去。' },
        { type: 'tool', callId: 'fold-bash-1', name: 'bash', args: '{"command":"npm run build"}', status: 'done', output: 'build ok in 11.8s' },
        { type: 'tool', callId: 'fold-write-1', name: 'write', args: '{"path":"scripts/build.mjs"}', status: 'done', output: 'updated scripts/build.mjs' },
        { type: 'text', text: collapsedCommentary2 },
      ], { turn: 1, step: 2, model: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
      message('s-1013-a3', 4, 'assistant', now - 6 * MIN, [
        { type: 'text', text: collapsedFinalText },
      ], { turn: 1, step: 3, model: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
    ],
    turns: { 1: { turn: 1, startedAt: now - 500000, endedAt: now - 126000 } },
    hasMore: false,
    running: false,
    nextTurn: 2,
    nextSeq: 5,
    streaming: null,
    streamingTimer: null,
    changes: {},
    diffs: {},
  });

  chats.set('s-1012', {
    messages: [
      message('s-1012-u1', 1, 'user', now - 6 * MIN, [{ type: 'text', text: abortedUserText }], { turn: 1 }),
      message('s-1012-a1', 2, 'assistant', now - 5 * MIN, [
        { type: 'reasoning', text: '先定位需要改的文件。' },
        { type: 'tool', callId: 'abort-read-1', name: 'read_file', args: '{"path":"client/index.js"}', status: 'done', output: '// client entry' },
        { type: 'text', text: abortedCommentary },
      ], { turn: 1, step: 1, model: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
      message('s-1012-a2', 3, 'assistant', now - 4 * MIN, [
        { type: 'reasoning', text: '开始修改 client/index.js。' },
        { type: 'tool', callId: 'abort-edit-1', name: 'edit', args: '{"path":"client/index.js"}', status: 'running' },
      ], { turn: 1, step: 2, model: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
      message('s-1012-a3', 4, 'assistant', now - 3 * MIN, [
        { type: 'tool', callId: 'abort-bash-1', name: 'bash', args: '{"command":"npm test"}', status: 'running' },
        { type: 'text', text: '测试还没跑完，任务被中止了。' },
      ], { turn: 1, step: 3, model: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
    ],
    turns: { 1: { turn: 1, startedAt: now - 300000, endedAt: now - 190000, reasonKind: 'aborted' } },
    hasMore: false,
    running: false,
    nextTurn: 2,
    nextSeq: 5,
    streaming: null,
    streamingTimer: null,
    changes: {},
    diffs: {},
  });

  diffs.set('s-1001', buildDiffs());
  changes.set('s-1001', buildChanges());
  chats.get('s-1001').changes = changes.get('s-1001');
  chats.get('s-1001').diffs = diffs.get('s-1001');
  chats.get('s-1001').turns = { 3: { turn: 3, startedAt: now - 800000, endedAt: now - 426000 } };

  return {
    now,
    sessions,
    workspaces: WORKSPACES,
    catalog: MODEL_CATALOG,
    chats,
    changes,
    diffs,
    sockets: new Set(),
    mockQuestions: new Map(),
    demoQuestionSent: false,
    defaultModel: { ...MODEL_CATALOG.default },
    account: {
      available: true,
      signedIn: true,
      status: 'ready',
      balance: [{ currency: 'CNY', balance: '42.80' }],
      bonusWallets: [{ currency: 'CNY', balance: '10.00' }],
    },
    plugins: {
      available: true,
      managementAvailable: true,
      entries: [
        { entryId: 'remote-control', moduleName: 'dsh-mobile-remote-control', enabled: true, phase: 'active', title: '移动端远程控制', description: null, icon: null, isRemoteControl: true },
        { entryId: 'session', moduleName: '@deepseek-ai/dsh-session', enabled: true, phase: 'active', title: null, description: null, icon: null, isRemoteControl: false },
        { entryId: 'agent-modes', moduleName: 'dsh-agent-modes', enabled: false, phase: null, title: 'Agent Modes', description: null, icon: null, isRemoteControl: false },
      ],
    },
  };
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function counts(store) {
  return {
    workspaces: store.workspaces.length,
    sessions: store.sessions.length,
    running: store.sessions.filter((s) => s.running).length,
  };
}

function bootstrap(store) {
  return {
    server: { version: '2.0.0-mock', hostName: 'MOCK-DEV', platform: 'win32', protocol: 1 },
    deviceCount: 1,
    counts: counts(store),
    defaultModel: clone(store.defaultModel),
    workspaces: clone(store.workspaces),
    sessions: clone(store.sessions),
    models: clone(store.catalog),
  };
}

function listData(store) {
  return {
    counts: counts(store),
    workspaces: clone(store.workspaces),
    sessions: clone(store.sessions),
  };
}

function findSession(store, id) {
  return store.sessions.find((s) => s.id === id) || null;
}

function chatOf(store, id) {
  return store.chats.get(id) || null;
}

function pageMessages(chat, beforeSeq, maxMessages) {
  const all = chat.messages;
  const list = typeof beforeSeq === 'number' ? all.filter((m) => typeof m.seq === 'number' && m.seq < beforeSeq) : all;
  const page = list.slice(-(maxMessages || 60));
  return {
    messages: clone(page),
    hasMore: list.length > page.length,
    oldestSeq: page.length ? page[0].seq : null,
    changes: clone(Object.values(chat.changes || {})),
    turns: clone(Object.values(chat.turns || {})),
  };
}

function broadcast(store, payload) {
  for (const socket of store.sockets) socket.push(payload);
}

function pushEvent(store, sessionId, event) {
  broadcast(store, { type: 'event', sessionId, event });
}

function appendMessage(store, sessionId, item) {
  const chat = chatOf(store, sessionId);
  if (!chat) return;
  chat.messages.push(item);
  chat.nextSeq = Math.max(chat.nextSeq, (item.seq || 0) + 1);
}

function bumpSession(store, sessionId, patch) {
  const session = findSession(store, sessionId);
  if (!session) return null;
  Object.assign(session, patch);
  return session;
}

function makeTitle(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 24 ? cleaned.slice(0, 24) + '…' : cleaned || '新任务';
}

/* ------------------------------------------------------------------ */
/* 流式模拟                                                            */
/* ------------------------------------------------------------------ */

function clearStreamTimers(chat) {
  if (chat.streamingTimer) {
    for (const timer of chat.streamingTimer) clearTimeout(timer);
    chat.streamingTimer = null;
  }
}

function simulatePrompt(store, sessionId, text, attachments) {
  const chat = chatOf(store, sessionId);
  const session = findSession(store, sessionId);
  if (!chat || !session) return;

  clearStreamTimers(chat);
  chat.streaming = null;
  chat.running = true;
  const startedAt = Date.now();
  const attemptId = 'attempt-' + Date.now();
  const turn = chat.nextTurn;
  chat.nextTurn += 1;
  const userSeq = chat.nextSeq;
  chat.nextSeq += 1;

  const imageBlocks = (Array.isArray(attachments) ? attachments : [])
    .filter((attachment) => attachment && attachment.mediaType)
    .map((attachment, index) => {
      const previewUrl = typeof attachment.previewUrl === 'string' && attachment.previewUrl
        ? attachment.previewUrl
        : typeof attachment.dataBase64 === 'string' && attachment.dataBase64
          ? 'data:' + attachment.mediaType + ';base64,' + attachment.dataBase64
          : '';
      return {
        type: 'image',
        attachmentId: 'mock-pending-img-' + turn + '-' + index,
        mediaType: attachment.mediaType,
        width: attachment.width,
        height: attachment.height,
        ...(previewUrl ? { previewUrl } : {}),
      };
    });
  const userBlocks = [...imageBlocks];
  if (text) userBlocks.push({ type: 'text', text });

  const userMessage = message('u-' + userSeq, userSeq, 'user', Date.now(), userBlocks, { turn });
  appendMessage(store, sessionId, userMessage);
  const wasBlank = session.blank;
  bumpSession(store, sessionId, {
    running: true,
    updatedAt: Date.now(),
    turns: turn,
    blank: false,
    title: wasBlank ? makeTitle(text || (imageBlocks.length ? '图片消息' : '')) : session.title,
  });

  const timers = [];
  const after = (ms, fn) => {
    const id = setTimeout(() => {
      if (chat.streaming !== attemptId) return;
      fn();
    }, ms);
    timers.push(id);
  };
  chat.streaming = attemptId;
  chat.streamingTimer = timers;

  const streamReasoning = '先确认用户诉求，再基于当前工作区上下文给出可执行的修改方案。检查依赖与现有测试，避免引入回归。';
  const streamText = [
    ...(imageBlocks.length ? ['已收到你发来的 ' + imageBlocks.length + ' 张图片，我先看一下。\n\n'] : []),
    '收到，我先核对当前工作区的状态。\n\n',
    '### 当前进度\n\n',
    '- MTU 处理已经按 peer → local → min 的顺序调整完成；\n',
    '- 断线重连补上了 `hello` / `list` / `open` 的重新订阅；\n',
    '- 客户端会按 `seq` 去重，避免历史与实时事件交叉。\n\n',
    '```js\nws.onopen = () => {\n  resubscribe();\n};\n```\n\n',
    '接下来我会跑一遍完整验证，并把结果贴在这里。',
  ];

  after(60, () => {
    pushEvent(store, sessionId, { kind: 'message', message: clone(userMessage) });
    if (wasBlank) pushEvent(store, sessionId, { kind: 'title', title: session.title });
    pushEvent(store, sessionId, { kind: 'status', running: true, turn, time: startedAt });
    broadcast(store, { type: 'session-meta', data: { sessionId, running: true, title: session.title, updatedAt: session.updatedAt } });
  });
  after(140, () => {
    pushEvent(store, sessionId, { kind: 'stream-start', attemptId, turn, step: 1 });
  });

  let elapsed = 220;
  for (let i = 0; i < streamReasoning.length; i += 18) {
    const chunk = streamReasoning.slice(i, i + 18);
    after(elapsed, () => {
      pushEvent(store, sessionId, { kind: 'stream', attemptId, block: 'reasoning', text: chunk });
    });
    elapsed += 70;
  }
  elapsed += 160;
  for (const chunk of streamText) {
    after(elapsed, () => {
      pushEvent(store, sessionId, { kind: 'stream', attemptId, block: 'text', text: chunk });
    });
    elapsed += 90;
  }

  after(elapsed + 200, () => {
    const assistantMessage = message(
      'a-' + chat.nextSeq,
      chat.nextSeq,
      'assistant',
      Date.now(),
      [
        { type: 'reasoning', text: streamReasoning },
        {
          type: 'tool',
          callId: 'call-' + attemptId,
          name: 'bash',
          args: '{"command":"node --test test/network-helper.test.mjs"}',
          status: 'done',
          output: 'ok 12 tests passed (0 failed)',
        },
        { type: 'text', text: streamText.join('') },
      ],
      {
        turn,
        step: 1,
        model: session.model || { provider: 'deepseek-account', model: 'deepseek-flash' },
        usage: { inputTokens: 1980, outputTokens: 412 },
      },
    );
    chat.nextSeq += 1;
    appendMessage(store, sessionId, assistantMessage);
    pushEvent(store, sessionId, { kind: 'message', message: clone(assistantMessage) });

    const summary = {
      turn,
      cwd: session.workspacePath || 'D:\\',
      files: [{ path: 'src/web/app.js', display: 'src/web/app.js', added: 24, deleted: 8 }],
      total: 1,
      added: 24,
      deleted: 8,
    };
    chat.changes[turn] = { seq: 300 + turn, summary };
    pushEvent(store, sessionId, { kind: 'changes', seq: 300 + turn, turn, summary });

    const endedAt = Date.now();
    chat.running = false;
    chat.streaming = null;
    chat.streamingTimer = null;
    chat.turns = chat.turns || {};
    chat.turns[turn] = { turn, startedAt, endedAt };
    bumpSession(store, sessionId, { running: false, updatedAt: endedAt, steps: (session.steps || 0) + 1 });
    pushEvent(store, sessionId, { kind: 'status', running: false, time: endedAt });
    pushEvent(store, sessionId, { kind: 'turn-end', turn, ok: true, time: endedAt });
    broadcast(store, { type: 'session-meta', data: { sessionId, running: false, updatedAt: Date.now() } });
  });
}

function cancelStreaming(store, sessionId) {
  const chat = chatOf(store, sessionId);
  if (!chat) return;
  const hadStream = !!chat.streaming;
  clearStreamTimers(chat);
  chat.streaming = null;
  const session = findSession(store, sessionId);
  if (!hadStream && !chat.running && !(session && session.running)) return;
  chat.running = false;
  const endedAt = Date.now();
  const turn = Math.max(0, chat.nextTurn - 1);
  chat.turns = chat.turns || {};
  chat.turns[turn] = { turn, startedAt: endedAt - 1000, endedAt, reasonKind: 'aborted' };
  pushEvent(store, sessionId, { kind: 'status', running: false, time: endedAt });
  pushEvent(store, sessionId, { kind: 'turn-end', turn, ok: true, time: endedAt, reasonKind: 'aborted' });
  bumpSession(store, sessionId, { running: false, updatedAt: Date.now() });
  broadcast(store, { type: 'session-meta', data: { sessionId, running: false, updatedAt: Date.now() } });
}

/* ------------------------------------------------------------------ */
/* WS 协议                                                             */
/* ------------------------------------------------------------------ */

class MockSocket {
  constructor(store, handlers) {
    this.store = store;
    this.handlers = handlers;
    this.readyState = 0;
    this.closed = false;
    store.sockets.add(this);
    setTimeout(() => {
      if (this.closed) return;
      this.readyState = 1;
      this.handlers.onOpen?.();
      this.push({ type: 'hello', data: { protocol: 1, version: '2.0.0-mock', deviceCount: 1, serverTime: Date.now() } });
    }, 30);
  }

  push(payload) {
    if (this.closed) return;
    setTimeout(() => {
      if (!this.closed) this.handlers.onMessage?.(clone(payload));
    }, 4);
  }

  send(raw) {
    if (this.closed || this.readyState !== 1) return;
    let payload = raw;
    if (typeof raw === 'string') {
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
    }
    setTimeout(() => this.dispatch(payload), 8);
  }

  dispatch(msg) {
    const store = this.store;
    switch (msg.type) {
      case 'hello':
        this.push({ type: 'hello', data: bootstrap(store) });
        break;
      case 'list':
        this.push({ type: 'list', data: listData(store) });
        break;
      case 'open': {
        const session = findSession(store, msg.sessionId);
        if (!session) {
          this.push({ type: 'error', code: 'session_not_found', message: '会话不存在或已被删除' });
          break;
        }
        const chat = chatOf(store, msg.sessionId) || { messages: [], hasMore: false, changes: {} };
        const page = pageMessages(chat, undefined, 6);
        this.push({
          type: 'opened',
          sessionId: msg.sessionId,
          data: {
            summary: clone(session),
            model: clone(session.model),
            running: !!session.running,
            messages: page.messages,
            changes: page.changes,
            turns: page.turns,
            hasMore: page.hasMore,
            oldestSeq: page.oldestSeq,
            deliverables: chat.deliverables || [],
            usage: chat.usage || { tokens: { input: 18234, output: 5120, cacheRead: 130000, cacheWrite: 0, total: 153354 }, context: { pressureTokens: 51200, surfaceTokens: 210000, contextWindow: 1000000 } },
          },
        });
        if (!store.demoQuestionSent) {
          store.demoQuestionSent = true;
          const requestId = 'mock-demo-question';
          store.mockQuestions.set(requestId, { sessionId: msg.sessionId });
          setTimeout(() => {
            this.push({
              type: 'question-request',
              data: {
                requestId,
                sessionId: msg.sessionId,
                callId: 'call-demo',
                questions: [
                  {
                    id: 'q-plan',
                    question: '接下来先做哪一项？',
                    header: '下一步',
                    multiSelect: false,
                    options: [
                      { label: '补齐提问应答', description: '手机端可直接回答模型提问' },
                      { label: '补图片上传', description: '相册直接发截图' },
                    ],
                  },
                  {
                    id: 'q-note',
                    question: '还有别的补充吗？（可留空选下面）',
                    header: '补充',
                    multiSelect: false,
                    options: [{ label: '暂时没有' }],
                  },
                ],
                timeoutMs: 90000,
                expiresAt: Date.now() + 90000,
              },
            });
          }, 1200);
        }
        break;
      }
      case 'history': {
        const chat = chatOf(store, msg.sessionId);
        if (!chat) {
          this.push({ type: 'error', code: 'session_not_found', message: '会话不存在' });
          break;
        }
        const page = pageMessages(chat, msg.beforeSeq, msg.maxMessages || 60);
        this.push({ type: 'history', sessionId: msg.sessionId, data: page });
        break;
      }
      case 'prompt':
        this.push({ type: 'ack', requestId: msg.requestId, ok: true });
        simulatePrompt(store, msg.sessionId, String(msg.text || ''), msg.attachments);
        break;
      case 'cancel':
        cancelStreaming(store, msg.sessionId);
        break;
      case 'model': {
        const session = findSession(store, msg.sessionId);
        if (!session) break;
        const selection = { provider: msg.provider, model: msg.model };
        if (msg.reasoningEffort) selection.reasoningEffort = msg.reasoningEffort;
        bumpSession(store, msg.sessionId, { model: selection });
        session.model = clone(selection);
        pushEvent(store, msg.sessionId, { kind: 'model', selection });
        broadcast(store, { type: 'session-meta', data: { sessionId: msg.sessionId, model: selection } });
        break;
      }
      case 'models':
        this.push({ type: 'models', data: clone(store.catalog) });
        break;
      case 'usage': {
        const chat = store.chats.get(msg.sessionId);
        this.push({ type: 'usage', sessionId: msg.sessionId, data: chat && chat.usage ? clone(chat.usage) : { tokens: { input: 18234, output: 5120, cacheRead: 130000, cacheWrite: 0, total: 153354 }, context: { pressureTokens: 51200, surfaceTokens: 210000, contextWindow: 1000000 } } });
        break;
      }
      case 'question-answer': {
        const pending = store.mockQuestions && store.mockQuestions.get(msg.requestId);
        if (!pending) {
          this.push({ type: 'error', requestId: msg.requestId, code: 'question-gone', message: '提问已结束或已过期' });
          break;
        }
        store.mockQuestions.delete(msg.requestId);
        this.push({ type: 'ack', requestId: msg.requestId, ok: true });
        this.push({
          type: 'event',
          sessionId: pending.sessionId,
          event: { kind: 'message', message: message('mock-q-answer-' + Date.now(), 999, 'user', Date.now(), [{ type: 'text', text: '已回答：' + (msg.answers || []).map((a) => a.id + '=' + (a.selected.join('/') || a.custom || '')).join('，') }], {}) },
        });
        break;
      }
      case 'question-pending':
        this.push({ type: 'question-pending', sessionId: msg.sessionId, data: [] });
        break;
      case 'account':
        this.push({ type: 'account', data: clone(store.account) });
        break;
      case 'plugins':
        this.push({ type: 'plugins', data: clone(store.plugins) });
        break;
      case 'changes': {
        const chat = chatOf(store, msg.sessionId);
        const entry = Object.values(chat?.changes || {}).find((c) => c.seq === msg.seq) || null;
        this.push({ type: 'changes', sessionId: msg.sessionId, seq: msg.seq, data: { summary: clone(entry?.summary || null) } });
        break;
      }
      case 'diff': {
        const diffs = store.diffs.get(msg.sessionId) || {};
        this.push({
          type: 'diff',
          sessionId: msg.sessionId,
          seq: msg.seq,
          index: msg.index,
          data: { diff: clone(diffs[msg.seq + ':' + msg.index] || null) },
        });
        break;
      }
      case 'search': {
        const q = String(msg.query || '').trim().toLowerCase();
        const items = store.sessions
          .filter((s) => !q || (s.title + ' ' + s.workspaceTitle).toLowerCase().includes(q))
          .map((s) => ({
            sessionId: s.id,
            title: s.title,
            workspaceTitle: s.workspaceTitle,
            snippet: '与「' + s.title + '」相关的工作区改动与对话记录',
          }));
        this.push({ type: 'search', items, hasMore: false, mode: 'content' });
        break;
      }
      case 'create': {
        const session = createSession(store, msg.workspaceId);
        this.push({ type: 'created', sessionId: session.id });
        break;
      }
      case 'ping':
        this.push({ type: 'pong', timestamp: Date.now() });
        break;
      default:
        this.push({ type: 'error', code: 'unknown_type', message: '未知消息类型：' + msg.type });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.store.sockets.delete(this);
    setTimeout(() => this.handlers.onClose?.(1000, ''), 0);
  }
}

function createSession(store, workspaceId) {
  const workspace = store.workspaces.find((w) => w.id === workspaceId) || store.workspaces[0];
  const id = 's-' + Date.now().toString(36);
  const session = {
    id,
    title: '新任务',
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
    workspacePath: workspace.path,
    cwd: workspace.path,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    running: false,
    blank: true,
    agentAvailable: true,
    turns: 0,
    steps: 0,
    model: clone(store.defaultModel),
  };
  store.sessions.unshift(session);
  store.chats.set(id, { messages: [], hasMore: false, running: false, nextTurn: 1, nextSeq: 1, streaming: null, streamingTimer: null, changes: {}, diffs: {} });
  broadcast(store, { type: 'list', data: listData(store) });
  return session;
}

/* ------------------------------------------------------------------ */
/* HTTP 模拟                                                           */
/* ------------------------------------------------------------------ */

async function handleRequest(store, path, options = {}) {
  await new Promise((resolve) => setTimeout(resolve, 15));
  const method = (options.method || 'GET').toUpperCase();
  const url = new URL(path, 'http://mock.local');
  const pathname = url.pathname;
  const body = options.body || {};

  if (pathname === '/api/health') return { ok: true, version: '2.0.0-mock', startedAt: Date.now() - 3600_000 };
  if (pathname === '/api/bootstrap') return bootstrap(store);

  if (pathname === '/api/search') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const items = store.sessions
      .filter((s) => !q || (s.title + ' ' + s.workspaceTitle).toLowerCase().includes(q))
      .map((s) => ({
        sessionId: s.id,
        title: s.title,
        workspaceTitle: s.workspaceTitle,
        snippet: '与「' + s.title + '」相关的工作区改动与对话记录',
      }));
    return { items, hasMore: false, mode: 'content' };
  }

  if (pathname === '/api/sessions' && method === 'POST') {
    return { sessionId: createSession(store, body.workspaceId).id };
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const rest = sessionMatch[2] || '';
    const session = findSession(store, sessionId);
    if (!session) throw mockError('会话不存在或已删除', 404);
    const chat = chatOf(store, sessionId) || { messages: [], hasMore: false, changes: {} };

    if (!rest && method === 'GET') {
      const page = pageMessages(chat, undefined, 6);
      return {
        summary: clone(session),
        model: clone(session.model),
        running: !!session.running,
        messages: page.messages,
        changes: page.changes,
        turns: page.turns,
        hasMore: page.hasMore,
        oldestSeq: page.oldestSeq,
      };
    }
    if (rest === 'history' && method === 'GET') {
      const beforeSeq = Number(url.searchParams.get('beforeSeq'));
      const maxMessages = Number(url.searchParams.get('maxMessages')) || 60;
      return pageMessages(chat, Number.isFinite(beforeSeq) && beforeSeq > 0 ? beforeSeq : undefined, maxMessages);
    }
    if (rest === 'changes' && method === 'GET') {
      const seq = Number(url.searchParams.get('seq'));
      const entry = Object.values(chat.changes || {}).find((c) => c.seq === seq) || null;
      return { summary: clone(entry?.summary || null) };
    }
    const diffMatch = rest.match(/^changes\/(\d+)\/(\d+)$/);
    if (diffMatch && method === 'GET') {
      const diffs = store.diffs.get(sessionId) || {};
      return { diff: clone(diffs[diffMatch[1] + ':' + diffMatch[2]] || null) };
    }
    if (rest === 'prompt' && method === 'POST') {
      simulatePrompt(store, sessionId, String(body.text || ''), body.attachments);
      return { ok: true };
    }
    if (rest === 'cancel' && method === 'POST') {
      cancelStreaming(store, sessionId);
      return { ok: true };
    }
    if (rest === 'model' && method === 'POST') {
      const selection = { provider: body.provider, model: body.model };
      if (body.reasoningEffort) selection.reasoningEffort = body.reasoningEffort;
      bumpSession(store, sessionId, { model: selection });
      session.model = clone(selection);
      broadcast(store, { type: 'session-meta', data: { sessionId, model: selection } });
      return { ok: true, selection };
    }
    if (rest === 'title' && method === 'POST') {
      bumpSession(store, sessionId, { title: String(body.title || '').slice(0, 80) });
      return { ok: true, title: session.title };
    }
  }

  throw mockError('未实现的 mock 接口：' + method + ' ' + pathname, 404);
}

function mockError(messageText, status) {
  const error = new Error(messageText);
  error.status = status;
  return error;
}

/* ------------------------------------------------------------------ */
/* 出口                                                                */
/* ------------------------------------------------------------------ */

export function createMockNet() {
  const store = createStore();
  return {
    mode: 'mock',
    request: (path, options) => handleRequest(store, path, options),
    connect(handlers) {
      return new MockSocket(store, handlers);
    },
  };
}

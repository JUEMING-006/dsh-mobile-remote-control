#!/usr/bin/env node
/**
 * 生成 market/index.json：DSH 插件市场索引（format 1）。
 *
 * 用法：
 *   node scripts/gen-market-index.mjs                          # auto：有 git remote 用 git source，否则退回 npm 并提示
 *   node scripts/gen-market-index.mjs --source=npm             # 尚未建立 git 仓库时（发布到 npm 后使用）
 *   node scripts/gen-market-index.mjs --source=git             # 强制 git source（需要 origin + 至少一次 commit）
 *   node scripts/gen-market-index.mjs --index-url=https://<user>.github.io/<repo>/market/index.json
 *   node scripts/gen-market-index.mjs --dry-run                # 只打印，不写文件
 *
 * 选项：
 *   --source=auto|git|npm   源类型，默认 auto
 *   --name=<pkg>            插件包名，默认 package.json 的 name；若仍是旧名 dsh-remote-control，
 *                           自动使用发布目标名 dsh-mobile-remote-control（可用 --allow-old-name 禁止）
 *   --version=<ver>         版本，默认 package.json 的 version
 *   --timestamp=<unix>      发布时间（Unix 秒），默认当前时间；发布后建议改成 npm 上的真实发布时间
 *   --index-url=<url>       索引最终 URL，仅用于打印 icon 解析结果与部署提示
 *   --out=<path>            输出路径，默认 market/index.json
 *   --dry-run               只打印，不写文件
 *
 * 输出约束（由官方 @deepseek-ai/dsh-plugin-market-index 校验）：
 *   format=1；title/description 的语言 key 必须小写（zh-cn 可以，zh-CN 不行）且必须含 en；
 *   icon 为相对路径 ./icon.svg（相对索引 URL 解析）；版本号是精确 SemVer；git source 需要 40 位小写 sha。
 *
 * 生成后建议在装有 DSH 的机器上再用官方校验器验证（本脚本只做结构自检）：
 *   parseMarketIndex(JSON.parse(await readFile('market/index.json', 'utf8')),
 *     new URL('https://<user>.github.io/<repo>/market/index.json'))
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'market', 'index.json');
const DEFAULT_ICON = path.join(ROOT, 'icon.svg');
const MARKET_ICON = path.join(ROOT, 'market', 'icon.svg');
const RESERVED_OLD_NAME = 'dsh-remote-control';
const DEFAULT_RELEASE_NAME = 'dsh-mobile-remote-control';
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;

function parseArgs(argv) {
  const options = { source: 'auto', dryRun: false, allowOldName: false };
  for (const arg of argv) {
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (arg === '--allow-old-name') { options.allowOldName = true; continue; }
    const match = /^--([a-z-]+)=(.*)$/u.exec(arg);
    if (!match) throw new Error('无法识别的参数: ' + arg);
    options[match[1]] = match[2];
  }
  return options;
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

function tryGitInfo() {
  try {
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
    const commit = git(['rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/u.test(commit)) return null;
    const remote = git(['remote', 'get-url', 'origin']);
    const url = normalizeGitUrl(remote);
    if (!url) return null;
    return { commit, url, remote };
  } catch (error) {
    return null;
  }
}

/** 把常见 git remote 形式规范化为索引要求的 canonical https URL（无 .git 后缀）。 */
function normalizeGitUrl(remote) {
  let value = String(remote).trim();
  if (!value) return null;
  value = value.replace(/^git\+/u, '');
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(value);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    value = 'https://' + scp[1] + '/' + scp[2];
  }
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  let pathname = url.pathname.replace(/\/+$/u, '').replace(/\.git$/u, '');
  if (!/^(?:\/[^/]+){2,}$/u.test(pathname)) return null;
  url.pathname = pathname;
  return url.href.replace(/\/$/u, '');
}

function checkLocalized(value, label, problems) {
  if (typeof value === 'string') {
    if (!value.trim()) problems.push(label + ' 不能为空');
    return;
  }
  const keys = Object.keys(value || {});
  if (keys.length === 0) problems.push(label + ' 至少需要 en');
  if (!keys.includes('en')) problems.push(label + ' 必须包含 en');
  for (const key of keys) {
    if (!LANGUAGE_ID.test(key)) problems.push(label + '.' + key + ' 必须是全小写语言 id（如 zh-cn）');
    if (typeof value[key] !== 'string' || !value[key].trim()) problems.push(label + '.' + key + ' 不能为空');
  }
}

function checkIndex(index) {
  const problems = [];
  if (index.format !== 1) problems.push('$.format 必须为 1');
  checkLocalized(index.title, '$.title', problems);
  if (index.description !== undefined) checkLocalized(index.description, '$.description', problems);
  const plugins = Array.isArray(index.plugins) ? index.plugins : [];
  if (plugins.length === 0) problems.push('$.plugins 至少需要一个插件');
  for (let i = 0; i < plugins.length; i += 1) {
    const plugin = plugins[i];
    const at = '$.plugins[' + i + ']';
    if (typeof plugin.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(plugin.name)) {
      problems.push(at + '.name 不是合法 npm 包名');
    }
    checkLocalized(plugin.title, at + '.title', problems);
    if (plugin.description !== undefined) checkLocalized(plugin.description, at + '.description', problems);
    if (typeof plugin.icon !== 'string' || !plugin.icon.startsWith('./')) problems.push(at + '.icon 必须是相对路径（如 ./icon.svg）');
    const versions = Array.isArray(plugin.versions) ? plugin.versions : [];
    if (versions.length === 0) problems.push(at + '.versions 不能为空');
    for (let j = 0; j < versions.length; j += 1) {
      const entry = versions[j];
      const versionAt = at + '.versions[' + j + ']';
      if (!SEMVER.test(String(entry.version))) problems.push(versionAt + '.version 必须是精确 SemVer');
      if (!Number.isInteger(entry.publishTimestamp) || entry.publishTimestamp < 0) {
        problems.push(versionAt + '.publishTimestamp 必须是 Unix 秒整数');
      }
      const source = entry.source || {};
      if (source.type === 'git') {
        if (!/^[0-9a-f]{40}$/u.test(String(source.commit))) problems.push(versionAt + '.source.commit 必须是 40 位小写 sha');
        try {
          const url = new URL(source.url);
          if (url.protocol !== 'https:') problems.push(versionAt + '.source.url 必须是 https');
        } catch (error) {
          problems.push(versionAt + '.source.url 不是绝对 URL');
        }
      } else if (source.type !== 'npm') {
        problems.push(versionAt + '.source.type 必须是 npm 或 git');
      }
    }
  }
  return problems;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let name = options.name || manifest.name;
  if (name === RESERVED_OLD_NAME) {
    if (!options.allowOldName) {
      console.warn(
        '[market] package.json 仍是旧包名 ' + RESERVED_OLD_NAME + '（npm 上已被他人占用），' +
          '本次使用发布目标名 ' + DEFAULT_RELEASE_NAME + '。发布前请先执行 scripts/rename-package.mjs。'
      );
      name = DEFAULT_RELEASE_NAME;
    } else {
      console.warn('[market] 明确允许旧包名 ' + RESERVED_OLD_NAME + ' 写入市场索引（不推荐）。');
    }
  }

  const version = options.version || manifest.version;
  const publishTimestamp = options.timestamp ? Number(options.timestamp) : Math.floor(Date.now() / 1000);

  const gitInfo = tryGitInfo();
  let sourceType = options.source;
  if (sourceType === 'auto') sourceType = gitInfo ? 'git' : 'npm';
  if (sourceType !== 'git' && sourceType !== 'npm') throw new Error('--source 必须是 auto、git 或 npm');

  let source;
  if (sourceType === 'git') {
    if (!gitInfo) {
      throw new Error(
        '无法生成 git source：当前目录不是 git 仓库，或缺少 origin remote / 40 位 HEAD commit。' +
          '请先 git init、添加 origin 并提交，或改用 --source=npm。'
      );
    }
    source = { type: 'git', url: gitInfo.url, commit: gitInfo.commit };
  } else {
    source = { type: 'npm' };
  }

  const index = {
    format: 1,
    title: { en: "JUEMING-006's DSH plugins", 'zh-cn': 'JUEMING-006 的 DSH 插件源' },
    description: {
      en: 'Community plugins for DeepSeek Harness, starting with mobile remote control.',
      'zh-cn': 'DeepSeek Harness 社区插件源，首发为移动端远程控制插件。',
    },
    plugins: [
      {
        name,
        title: { en: 'Mobile Remote Control', 'zh-cn': '移动端远程控制' },
        description: {
          en: 'Scan a QR code in the DSH desktop app to view and control real sessions from a phone on the same LAN. No cloud relay.',
          'zh-cn': '在 DSH 桌面端点开「手机远控」扫码，用同一局域网内的手机查看和控制真实会话；无云端中继。',
        },
        icon: './icon.svg',
        author: 'JUEMING-006',
        metadata: {
          keywords: ['remote-control', 'mobile', 'local-network', 'qr-code', 'deepseek-harness'],
        },
        versions: [{ version, publishTimestamp, source }],
      },
    ],
  };

  const problems = checkIndex(index);
  if (problems.length > 0) {
    throw new Error('索引结构自检失败:\n  - ' + problems.join('\n  - '));
  }

  const out = options.out ? path.resolve(ROOT, options.out) : DEFAULT_OUT;
  console.log('[market] 包名: ' + name + '，版本: ' + version + '，source: ' + source.type);
  if (source.type === 'git') {
    console.log('[market] git: ' + source.url + ' @ ' + source.commit);
  } else {
    console.log('[market] npm: 发布后索引指向 ' + name + '@' + version + '（请确保已 npm publish）');
  }
  console.log('[market] publishTimestamp: ' + publishTimestamp);
  if (options['index-url']) {
    const indexUrl = new URL(options['index-url']);
    console.log('[market] icon 将解析为: ' + new URL('./icon.svg', indexUrl).href);
  } else {
    console.log('[market] 提示: 传入 --index-url=https://<user>.github.io/<repo>/market/index.json 可预览 icon 解析地址');
  }

  if (options.dryRun) {
    console.log('[market] dry-run：未写入 ' + path.relative(ROOT, out));
    console.log(JSON.stringify(index, null, 2));
    return;
  }

  const icon = fs.readFileSync(DEFAULT_ICON);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const previousIcon = fs.existsSync(MARKET_ICON) ? fs.readFileSync(MARKET_ICON) : null;
  if (!previousIcon || !previousIcon.equals(icon)) {
    fs.writeFileSync(MARKET_ICON, icon);
    console.log('[market] 已同步 icon.svg -> market/icon.svg');
  }
  fs.writeFileSync(out, JSON.stringify(index, null, 2) + '\n');
  console.log('[market] 已写入 ' + path.relative(ROOT, out).split(path.sep).join('/'));
  console.log('[market] 结构自检通过；请在装有 DSH 的机器上再用官方 parseMarketIndex 验证。');
}

try {
  main();
} catch (error) {
  console.error('[market] 失败: ' + (error && error.message ? error.message : String(error)));
  process.exit(1);
}

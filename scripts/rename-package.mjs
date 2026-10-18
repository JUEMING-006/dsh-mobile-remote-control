#!/usr/bin/env node
/**
 * 一条命令完成包改名（发布前执行，不是现在）。
 *
 * 为什么是脚本而不是直接改：用户当前实例的 profile（dependencies / dsh.profile.bundles /
 * node_modules/dsh-remote-control 目录）都指向旧名；直接改名会让正在使用的插件加载失败。
 * 发布前按 .verify/design/release.md 的顺序执行：先备份/迁移 profile，再跑本脚本，
 * 然后 npm pack / publish / 重新部署，最后完全重启 DeepSeek Harness。
 *
 * 用法：
 *   node scripts/rename-package.mjs --dry-run              # 预览将要改动的文件与行
 *   node scripts/rename-package.mjs                        # 执行改名（默认 dsh-mobile-remote-control）
 *   node scripts/rename-package.mjs --to=@scope/new-name   # 自定义新包名
 *   node scripts/rename-package.mjs --skip-pack            # 跳过 npm pack 校验（无 npm 环境）
 *
 * 覆盖位置（与 DSH 加载/显示强相关）：
 *   package.json name、package-lock.json name、cordis.patch.yml name、
 *   client/index.js（__ModuleLoader__.load 的 id 等全部旧名标识）、
 *   src/index.mjs（export const name 与 effect label）、
 *   src/server/host-bridge.mjs（改成语义等价的新旧名宽松匹配，一次到位）、
 *   src/server/mock-host.mjs、src/web/mock.js（mock 数据 moduleName）、
 *   test/verify-server.mjs（注释）、README.md（保留 <!-- rename-script:keep-start/end --> 区块）。
 *
 * 执行后自动校验：node --check 所有改动过的 JS、npm pack --dry-run 文件清单（必须含
 * package.json/README/LICENSE/icon/locale/cordis.patch/src/client，且不含 node_modules、
 * 测试、.github、.verify、artifacts、*.tgz）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OLD_NAME = 'dsh-remote-control';
const DEFAULT_NEW_NAME = 'dsh-mobile-remote-control';
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;

const KEEP_START = '<!-- rename-script:keep-start -->';
const KEEP_END = '<!-- rename-script:keep-end -->';

function parseArgs(argv) {
  const options = { dryRun: false, skipPack: false, to: DEFAULT_NEW_NAME };
  for (const arg of argv) {
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (arg === '--skip-pack') { options.skipPack = true; continue; }
    const match = /^--to=(.+)$/u.exec(arg);
    if (!match) throw new Error('无法识别的参数: ' + arg + '（支持 --dry-run、--to=<name>、--skip-pack）');
    options.to = match[1];
  }
  return options;
}

function replaceAll(text, from, to) {
  if (!from || from === to) return { text, count: 0 };
  const parts = text.split(from);
  return { text: parts.join(to), count: parts.length - 1 };
}

function replaceRegex(text, regex, to, label) {
  let count = 0;
  const next = text.replace(regex, (...args) => {
    count += 1;
    return typeof to === 'function' ? to(...args) : to;
  });
  if (count > 1 && label) console.warn('  ! ' + label + ' 命中 ' + count + ' 处（预期最多 1 处）');
  return { text: next, count };
}

/** 逐行替换 README，但保留 rename-script:keep-start/end 之间的迁移说明。 */
function replaceReadme(text, from, to) {
  const lines = text.split('\n');
  let keeping = false;
  let count = 0;
  const changedLines = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes(KEEP_START)) { keeping = true; continue; }
    if (line.includes(KEEP_END)) { keeping = false; continue; }
    if (keeping) continue;
    if (!line.includes(from)) continue;
    const next = line.split(from).join(to);
    count += 1;
    changedLines.push(i + 1);
    lines[i] = next;
  }
  return { text: lines.join('\n'), count, changedLines };
}

function buildPlan(newName) {
  const plan = [];
  const add = (file, transform, check) => {
    plan.push({ file, transform, check });
  };

  add('package.json', (text) => {
    const regex = /("name"\s*:\s*")dsh-remote-control(")/u;
    if (regex.test(text)) return replaceRegex(text, regex, (_m, a, b) => a + newName + b);
    return { text, count: 0 };
  });

  if (fs.existsSync(path.join(ROOT, 'package-lock.json'))) {
    add('package-lock.json', (text) => {
      const regex = /("name"\s*:\s*")dsh-remote-control(")/gu;
      return replaceRegex(text, regex, (_m, a, b) => a + newName + b);
    });
  }

  add('cordis.patch.yml', (text) => {
    const regex = /(\n\s*name:\s*)"?dsh-remote-control"?/u;
    return replaceRegex(text, regex, (_m, prefix) => prefix + '"' + newName + '"');
  });

  add('client/index.js', (text) => replaceAll(text, OLD_NAME, newName));
  add('src/index.mjs', (text) => replaceAll(text, OLD_NAME, newName));
  add('src/server/mock-host.mjs', (text) => replaceAll(text, OLD_NAME, newName));
  add('src/web/mock.js', (text) => replaceAll(text, OLD_NAME, newName));
  add('test/verify-server.mjs', (text) => replaceAll(text, OLD_NAME, newName));

  add('src/server/host-bridge.mjs', (text) => {
    const tolerant = '/dsh-(?:mobile-)?remote-control$/.test(String(entry.moduleName || \'\'))';
    if (text.includes(tolerant)) return { text, count: 0 };
    const regex = /isRemoteControl:\s*String\(entry\.moduleName \|\| ''\)\.includes\('[^']+'\),/u;
    if (!regex.test(text)) return { text, count: 0 };
    return replaceRegex(text, regex, 'isRemoteControl: ' + tolerant + ',');
  });

  add('README.md', (text) => replaceReadme(text, OLD_NAME, newName));
  return plan;
}

function runNodeCheck(relativeFile) {
  const result = spawnSync(process.execPath, ['--check', relativeFile], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    return { file: relativeFile, ok: false, detail: (result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join(' | ') };
  }
  return { file: relativeFile, ok: true };
}

function readPackFiles(newName) {
  // Windows 上 git/npm 都是 .cmd；直接 spawn 不会解析 PATHEXT，因此经由 cmd.exe /c 执行，
  // 同时避免 spawn(..., {shell:true, args}) 在 Node 24 上的 DEP0190 警告。
  const npmPackArgs = 'pack --dry-run --json --ignore-scripts';
  const isWindows = process.platform === 'win32';
  const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = isWindows ? ['/d', '/s', '/c', 'npm ' + npmPackArgs] : npmPackArgs.split(' ');
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error('npm pack --dry-run 失败: ' + ((result.stderr || result.stdout || '').trim().split('\n').slice(-4).join(' | ')));
  }
  let parsed;
  try {
    const raw = String(result.stdout || '');
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new Error('无法解析 npm pack --json 输出: ' + String(result.stdout || '').slice(0, 300));
  }
  const entry = parsed[0];
  if (!entry || !Array.isArray(entry.files)) throw new Error('npm pack --json 缺少 files 清单');
  const files = entry.files.map((item) => String(item.path).split(path.sep).join('/'));
  const problems = [];
  if (entry.name !== newName) problems.push('包名仍是 ' + entry.name + '，期望 ' + newName);
  const required = [
    'package.json', 'README.md', 'LICENSE', 'icon.svg',
    'locale/en.json', 'locale/zh.json', 'cordis.patch.yml',
    'src/index.mjs', 'client/index.js',
  ];
  for (const file of required) {
    if (!files.includes(file)) problems.push('缺少必需文件: ' + file);
  }
  const forbiddenPrefixes = ['node_modules/', 'test/', '.github/', '.verify/', 'artifacts/', '.plan/', '.refs/', '.tmp/'];
  for (const file of files) {
    if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) problems.push('不应打包: ' + file);
    if (file.endsWith('.tgz')) problems.push('不应打包 tarball: ' + file);
  }
  const tarball = entry.filename || '';
  if (tarball && !tarball.startsWith(newName + '-')) problems.push('tarball 名称不符合预期: ' + tarball);
  return { name: entry.name, version: entry.version, files, tarball, problems };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const newName = options.to.trim();
  if (!PACKAGE_NAME_PATTERN.test(newName)) throw new Error('目标包名不合法: ' + newName);
  if (newName === OLD_NAME) throw new Error('目标包名不能与旧包名相同');

  const manifestPath = path.join(ROOT, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log('[rename] 当前包名: ' + manifest.name);
  console.log('[rename] 目标包名: ' + newName);
  console.log('[rename] 模式: ' + (options.dryRun ? 'dry-run（不写文件）' : '实际执行'));

  if (manifest.name === newName) {
    console.log('[rename] package.json 已经是目标包名，无需改名。');
    return;
  }

  const plan = buildPlan(newName);
  const changed = [];
  const unchanged = [];

  for (const entry of plan) {
    const absolute = path.join(ROOT, entry.file);
    if (!fs.existsSync(absolute)) {
      console.log('  ? ' + entry.file + '（不存在，跳过）');
      continue;
    }
    const before = fs.readFileSync(absolute, 'utf8');
    const result = entry.transform(before);
    if (result.count === 0 || result.text === before) {
      unchanged.push(entry.file);
      console.log('  = ' + entry.file + '（无旧包名，跳过）');
      continue;
    }
    changed.push({ file: entry.file, count: result.count, changedLines: result.changedLines || [] });
    console.log('  + ' + entry.file + '：' + result.count + ' 处' + (result.changedLines && result.changedLines.length > 0 ? '（行 ' + result.changedLines.slice(0, 8).join(', ') + '）' : ''));
    if (!options.dryRun) fs.writeFileSync(absolute, result.text);
  }

  if (changed.length === 0) {
    console.log('[rename] 没有需要修改的内容。');
    return;
  }
  if (options.dryRun) {
    console.log('[rename] dry-run 完成，未写入任何文件；共计划修改 ' + changed.length + ' 个文件（' + changed.reduce((sum, item) => sum + item.count, 0) + ' 处）。');
    return;
  }

  console.log('[rename] 写入完成，开始校验 ...');

  const jsFiles = changed
    .map((item) => item.file)
    .filter((file) => file.endsWith('.js') || file.endsWith('.mjs'));
  const checkResults = jsFiles.map(runNodeCheck);
  for (const result of checkResults) {
    console.log('  ' + (result.ok ? 'OK  ' : 'FAIL') + ' node --check ' + result.file + (result.ok ? '' : ' :: ' + result.detail));
  }
  if (checkResults.some((result) => !result.ok)) {
    throw new Error('node --check 未通过');
  }

  if (options.skipPack) {
    console.log('[rename] 已跳过 npm pack 校验（--skip-pack）。');
  } else {
    const pack = readPackFiles(newName);
    console.log('[rename] npm pack --dry-run: ' + pack.name + '@' + pack.version + '，' + pack.files.length + ' 个文件，tarball=' + pack.tarball);
    for (const file of pack.files) console.log('    ' + file);
    if (pack.problems.length > 0) {
      throw new Error('npm pack 校验失败:\n  - ' + pack.problems.join('\n  - '));
    }
    console.log('[rename] npm pack 校验 PASS（必需文件齐全、无测试/构建垃圾）。');
  }

  console.log('');
  console.log('[rename] 改名完成。后续顺序（详见 .verify/design/release.md）：');
  console.log('  1) 迁移用户 profile 的 dependencies / dsh.profile.bundles / cordis.patch.yml 与 node_modules 目录');
  console.log('  2) node scripts/gen-market-index.mjs（选择 git 或 npm source）');
  console.log('  3) npm pack / npm publish');
  console.log('  4) node scripts/deploy.mjs（目标目录会自动使用新包名）');
  console.log('  5) 完全退出并重启 DeepSeek Harness');
}

try {
  main();
} catch (error) {
  console.error('[rename] 失败: ' + (error && error.message ? error.message : String(error)));
  process.exit(1);
}

#!/usr/bin/env node
/**
 * DSH 插件部署脚本（包名取自 package.json，改名后无需修改本文件）
 *
 * 将本仓库的 src/、client/、package.json、cordis.patch.yml、README.md 同步到
 * DSH 桌面端 profile 的插件目录：
 * %USERPROFILE%\.dsh\profiles\desktop\node_modules\<package.json name>\
 *
 * 特性：
 * - 幂等：内容相同的文件不会重复写盘，可反复执行；
 * - 安全：只覆盖上面列出的文件，绝不删除目标目录中的其它文件；
 * - --dry-run 只打印将要发生的变更，不写任何文件。
 *
 * 用法：
 *   node scripts/deploy.mjs             # 真正部署
 *   node scripts/deploy.mjs --dry-run   # 预览变更
 *   node scripts/deploy.mjs --target=D:\some\dir   # 自定义目标（测试用）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 包名以 package.json 为准：执行 scripts/rename-package.mjs 改名后，部署目标自动跟着变
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
  throw new Error('package.json 缺少有效的 name');
}
const PACKAGE_NAME = manifest.name;
const PROFILE_DIR = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const DEFAULT_TARGET = path.join(PROFILE_DIR, 'node_modules', PACKAGE_NAME);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const targetArg = args.find((arg) => arg.startsWith('--target='));
const target = targetArg ? path.resolve(targetArg.slice('--target='.length)) : DEFAULT_TARGET;

// 需要同步的内容（目录递归，文件单个）；目标目录中的其它文件保持原样
const ENTRIES = [
  { from: 'src', type: 'dir' },
  { from: 'client', type: 'dir' },
  { from: 'package.json', type: 'file' },
  { from: 'cordis.patch.yml', type: 'file' },
  { from: 'README.md', type: 'file' },
];

// 目标目录若是指向本仓库的 junction/symlink（link: 安装或手工 junction），
// 目标内容就是仓库本身：跳过拷贝，只做校验。
function isLinkedToRepo(targetPath) {
  try {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isSymbolicLink()) return false;
    const real = fs.realpathSync(targetPath);
    const repo = fs.realpathSync(ROOT);
    return path.resolve(real).toLowerCase() === path.resolve(repo).toLowerCase();
  } catch {
    return false;
  }
}

// v1 files replaced by the v2 architecture: remove them from the target only.
// They are never imported anymore, but a stale copy would confuse debugging.
const OBSOLETE = ['src/server/dsh-bridge.mjs'];

function rel(p) {
  return p.split(path.sep).join('/');
}

function walkFiles(absDir, baseDir, out) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const absPath = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(absPath, baseDir, out);
    } else if (entry.isFile()) {
      out.push(path.relative(baseDir, absPath));
    }
  }
}

function collectSources() {
  const files = [];
  for (const entry of ENTRIES) {
    const absPath = path.join(ROOT, entry.from);
    if (!fs.existsSync(absPath)) {
      throw new Error('缺少必需文件或目录：' + entry.from);
    }
    if (entry.type === 'dir') {
      walkFiles(absPath, ROOT, files);
    } else {
      files.push(path.relative(ROOT, absPath));
    }
  }
  return files;
}

function readIfExists(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    return fs.readFileSync(absPath);
  } catch {
    return null;
  }
}

function main() {
  if (isLinkedToRepo(target)) {
    console.log('[deploy] 目标目录是指向本仓库的链接，跳过拷贝（仓库即产物）。');
    console.log('[deploy] 仓库目录: ' + ROOT);
    console.log('[deploy] 目标目录: ' + target);
    console.log('[deploy] 提示: 重启 DeepSeek Harness 即可加载当前代码。');
    process.exit(0);
  }

  const files = collectSources();
  const additions = [];
  const updates = [];
  const unchanged = [];

  for (const file of files) {
    const sourcePath = path.join(ROOT, file);
    const destPath = path.join(target, file);
    const sourceBuffer = fs.readFileSync(sourcePath);
    const destBuffer = readIfExists(destPath);

    if (!destBuffer) additions.push(file);
    else if (!sourceBuffer.equals(destBuffer)) updates.push(file);
    else unchanged.push(file);
  }

  console.log('[deploy] 仓库目录: ' + ROOT);
  console.log('[deploy] 包名: ' + PACKAGE_NAME);
  console.log('[deploy] 目标目录: ' + target);
  console.log(
    '[deploy] 模式: ' + (dryRun ? 'dry-run（只打印，不写文件）' : '实际写入')
  );

  if (!fs.existsSync(path.dirname(target))) {
    if (dryRun) {
      console.log('[deploy] 提示: 目标父目录当前不存在，正式执行时会自动创建。');
    }
  }

  for (const file of additions) {
    if (!dryRun) {
      const destPath = path.join(target, file);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), destPath);
    }
    console.log('  + ' + rel(file) + (dryRun ? ' （将新增）' : ' （新增）'));
  }
  for (const file of updates) {
    if (!dryRun) {
      const destPath = path.join(target, file);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), destPath);
    }
    console.log('  ~ ' + rel(file) + (dryRun ? ' （将更新）' : ' （更新）'));
  }
  for (const file of unchanged) {
    console.log('  = ' + rel(file) + ' （未变化）');
  }

  for (const file of OBSOLETE) {
    const destPath = path.join(target, file);
    if (!fs.existsSync(destPath)) continue;
    if (!dryRun) fs.rmSync(destPath, { force: true });
    console.log('  - ' + rel(file) + (dryRun ? ' （将移除 v1 遗留文件）' : ' （已移除 v1 遗留文件）'));
  }

  console.log(
    '[deploy] 文件总数 ' +
      files.length +
      '：新增 ' +
      additions.length +
      (dryRun ? '（待新增）' : '') +
      '，更新 ' +
      updates.length +
      (dryRun ? '（待更新）' : '') +
      '，未变化 ' +
      unchanged.length
  );
  console.log('[deploy] 目标目录中的其它文件不会被删除。');

  // 改名迁移提醒：旧包目录还在时，profile 的 bundles / dependency 仍需手动迁移
  if (PACKAGE_NAME !== 'dsh-remote-control') {
    const legacyDir = path.join(PROFILE_DIR, 'node_modules', 'dsh-remote-control');
    if (fs.existsSync(legacyDir)) {
      console.log(
        '[deploy] 注意: 检测到旧包目录 ' +
          legacyDir +
          '。改名后还需迁移 profile 的 dependencies / dsh.profile.bundles / cordis.patch.yml，' +
          '否则插件不会加载；步骤见 .verify/design/release.md。'
      );
    }
  }

  if (dryRun) {
    console.log('[deploy] dry-run 完成，未写入任何文件。');
  } else {
    console.log('[deploy] 部署完成。请重启 DeepSeek Harness 生效。');
  }
}

try {
  main();
} catch (error) {
  console.error('[deploy] 失败: ' + (error && error.message ? error.message : String(error)));
  process.exit(1);
}

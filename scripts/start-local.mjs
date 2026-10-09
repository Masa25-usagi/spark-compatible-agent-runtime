import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const lockPath = join(root, '.spark-runtime-start.lock');

function openBrowser(port) {
  execFile('open', [`http://127.0.0.1:${port}/`], (error) => {
    if (error) {
      console.error('ブラウザを開く際にエラーが発生しました:', error.message);
    }
  });
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isCurrentProjectLock(lock) {
  return (
    lock !== null &&
    typeof lock === 'object' &&
    lock.root === root &&
    Number.isInteger(lock.pid) &&
    lock.pid > 0 &&
    (lock.port === undefined || isValidPort(lock.port))
  );
}

function openExistingInstance(lock) {
  if (!isCurrentProjectLock(lock)) return false;
  try {
    process.kill(lock.pid, 0);
  } catch {
    return false;
  }
  if (!lock.port) {
    console.log('このプロジェクトは起動準備中です。重複起動せず、そのままお待ちください。');
    return true;
  }
  console.log(`このプロジェクトは既に起動しています (ポート: ${lock.port})。`);
  console.log('既存の画面をブラウザで開きます。');
  openBrowser(lock.port);
  return true;
}

function acquireStartLock() {
  try {
    const descriptor = openSync(lockPath, 'wx');
    closeSync(descriptor);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, root }, null, 2));
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (openExistingInstance(lock)) return false;
    } catch {
      // A partially written or stale lock is safe to replace below.
    }
    unlinkSync(lockPath);
    const descriptor = openSync(lockPath, 'wx');
    closeSync(descriptor);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, root }, null, 2));
    return true;
  }
}

function releaseStartLock() {
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (isCurrentProjectLock(lock) && lock.pid === process.pid) {
      unlinkSync(lockPath);
    }
  } catch {
    // The lock may already have been removed during shutdown.
  }
}

if (!acquireStartLock()) process.exit(0);
process.once('exit', releaseStartLock);
process.once('SIGINT', releaseStartLock);
process.once('SIGTERM', releaseStartLock);

// 1. Check Node.js version >= 22.5.0
const nodeVersion = process.versions.node;
const [major, minor] = nodeVersion.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `\x1b[31mエラー: Node.jsのバージョンが古すぎます（現在: v${nodeVersion}）。\x1b[0m`,
  );
  console.error(`本システムを実行するには Node.js バージョン 22.5.0 以上が必要です。`);
  console.error(`公式サイトから最新安定版をダウンロードしてインストールしてください:`);
  console.error(`https://nodejs.org/`);
  process.exit(1);
}
console.log(`Node.js バージョンを確認しました: v${nodeVersion}`);

// Helper to spawn a process and stream output
function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} がコード ${code} で終了しました。`));
    });
    child.on('error', reject);
  });
}

// 2. Install dependencies if missing
const rootNodeModules = join(root, 'node_modules');
if (!existsSync(rootNodeModules)) {
  console.log('ルート依存関係をインストールしています...');
  await runCommand('npm', ['ci', '--ignore-scripts'], root);
}

const webNodeModules = join(root, 'web', 'node_modules');
if (!existsSync(webNodeModules)) {
  console.log('Web UI 依存関係をインストールしています...');
  await runCommand('npm', ['ci', '--ignore-scripts', '--prefix', 'web'], root);
}

// 3. Build backend and frontend
console.log('バックエンドをビルドしています...');
await runCommand('npm', ['run', 'build'], root);

console.log('フロントエンドをビルドしています...');
await runCommand('npm', ['run', 'web:build'], root);

// 4. Find available port starting at 4317 or honor SPARK_PORT
async function findAvailablePort(startPort) {
  let port = startPort;
  while (true) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.on('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });
    if (available) return port;
    port++;
  }
}

let startPort = 4317;
if (process.env.SPARK_PORT) {
  const parsed = parseInt(process.env.SPARK_PORT, 10);
  if (!isNaN(parsed)) {
    startPort = parsed;
  }
}
const port = await findAvailablePort(startPort);
console.log(`使用可能なポートを選択しました: ${port}`);
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port, root }, null, 2));

// Helper to wait until API port is open
async function waitPortReady(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`APIサーバー (ポート: ${port}) が時間内に起動しませんでした。`);
}

// 5. Start the API/runtime process
console.log('APIサーバーを起動しています...');
const apiProcess = spawn('node', ['dist/src/api-cli.js', '--port', String(port)], {
  cwd: root,
  stdio: 'inherit',
});

// Clean termination handler
function cleanup() {
  if (apiProcess) {
    console.log('\n子プロセスをクリーンアップしています...');
    apiProcess.kill('SIGTERM');
  }
}

process.once('SIGINT', () => {
  cleanup();
  process.exit(0);
});

process.once('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

apiProcess.on('close', (code) => {
  console.log(`APIサーバーがコード ${code} で終了しました。`);
  process.exit(code ?? 0);
});

// Wait for API to be ready, then open browser on macOS
try {
  await waitPortReady(port);
  console.log('APIサーバーの起動を確認しました。');
  console.log('ブラウザを開いています...');
  openBrowser(port);
} catch (error) {
  console.error(error.message);
  cleanup();
  process.exit(1);
}

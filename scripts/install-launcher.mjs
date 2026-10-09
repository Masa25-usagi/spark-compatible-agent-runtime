import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const binDir = join(homedir(), '.local', 'bin');
const marker = '# Spark Runtime launcher; managed by START.command.';

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isManagedLauncher(launcherPath) {
  try {
    return readFileSync(launcherPath, 'utf8').includes(marker);
  } catch {
    return false;
  }
}

function launcherContents() {
  return `#!/usr/bin/env bash
${marker}
set -u
SPARK_RUNTIME_ROOT=${shellQuote(root)}

if [ ! -d "$SPARK_RUNTIME_ROOT" ] || [ ! -f "$SPARK_RUNTIME_ROOT/package.json" ]; then
  echo "エラー: Spark Runtime のプロジェクトが見つかりません。" >&2
  echo "プロジェクトを移動または削除した場合は、新しい場所の START.command を一度実行してください。" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "エラー: npm が見つかりません。Node.js をインストールしてください。" >&2
  exit 1
fi

exec npm --prefix "$SPARK_RUNTIME_ROOT" run spark-cli -- "$@"
`;
}

function updateLauncher(command) {
  const launcherPath = join(binDir, command);
  const temporaryPath = `${launcherPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, launcherContents(), { mode: 0o755 });
  renameSync(temporaryPath, launcherPath);
  console.log(`CLIランチャーを更新しました: ${launcherPath}`);
}

if (!existsSync(binDir)) {
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
}

const primaryLauncherPath = join(binDir, 'spark');
if (existsSync(primaryLauncherPath) && !isManagedLauncher(primaryLauncherPath)) {
  console.log(`既存の ${primaryLauncherPath} は別のコマンドのため上書きしません。`);
  const fallbackLauncherPath = join(binDir, 'spark-runtime');
  if (existsSync(fallbackLauncherPath) && !isManagedLauncher(fallbackLauncherPath)) {
    console.log(
      `既存の ${fallbackLauncherPath} も別のコマンドのため、ランチャーを導入できませんでした。`,
    );
    console.log(
      'このフォルダの START.command を使うか、管理者にコマンド名の変更を依頼してください。',
    );
  } else {
    updateLauncher('spark-runtime');
    console.log('この環境では spark-runtime providers:list を使ってください。');
  }
} else {
  updateLauncher('spark');
}

const pathEntries = (process.env.PATH ?? '').split(':');
if (!pathEntries.includes(binDir)) {
  console.log(`案内: ${binDir} が PATH に含まれていません。`);
  console.log(`今後、任意の場所から spark を使うには、シェル設定に次を追加してください:`);
  console.log(`  export PATH="$HOME/.local/bin:$PATH"`);
}

#!/usr/bin/env bash
# Move to the directory containing this script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Spark Runtime を起動しています..."

# Check if Node.js is installed
if ! command -v node &> /dev/null
then
    echo "エラー: Node.js がインストールされていません。"
    echo "本システムを実行するには Node.js バージョン 22.5.0 以上が必要です。"
    echo "公式サイトからダウンロードしてインストールしてください:"
    echo "https://nodejs.org/"
    echo ""
    echo "キーを押すと終了します..."
    read -n 1
    exit 1
fi

# Install/update the location-independent CLI launcher before starting the UI.
node scripts/install-launcher.mjs

# Run the local launcher
node scripts/start-local.mjs

---
layout: page
title: "インストール・セットアップ"
permalink: /getting-started/
---

# インストール・セットアップ

このガイドでは、Discord AI Voice Botの環境構築から初回起動までの手順を説明します。

## 📋 システム要件

### 必須要件
- **Go 1.21+** - メインプログラムの実行
- **Docker & Docker Compose** - 外部サービスの起動
- **Git** - リポジトリのクローン
- **Discord Bot Token** - Discordアプリケーション

### 推奨環境
- **Linux (Ubuntu 20.04+)** または **macOS 12+**
- **メモリ 8GB+** - AI処理とDocker実行
- **ストレージ 10GB+** - モデルファイルとログ

## 🚀 インストール手順

### 1. リポジトリのクローン

```bash
git clone https://github.com/g-kari/discord-friend.git
cd discord-friend
```

### 2. Go実装の環境構築

```bash
cd src/bot-go

# 環境変数ファイルの作成
cp .env.example .env

# 必要な依存関係のインストール
go mod download

# Opus ライブラリのインストール (音声処理に必要)
# Ubuntu/Debian の場合:
sudo apt-get update
sudo apt-get install libopus-dev

# macOS の場合:
brew install opus
```

### 3. Discord Bot の設定

#### Discord Developer Portal での設定

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. 「New Application」をクリックしてアプリケーションを作成
3. 「Bot」セクションに移動
4. 「Add Bot」をクリック
5. Bot Token をコピー

#### 必要な権限の設定

Bot に以下の権限を付与してください：

- **Text Permissions**:
  - Send Messages
  - Use Slash Commands
  - Read Message History

- **Voice Permissions**:
  - Connect
  - Speak
  - Use Voice Activity

#### 環境変数の設定

`.env` ファイルを編集して必要な情報を設定：

```env
# Discord設定 (必須)
DISCORD_BOT_TOKEN=your_bot_token_here

# AI サービス設定
PREFER_LOCAL_LLM=true
OLLAMA_API_URL=http://localhost:11434
DIFY_API_KEY=your_dify_key
DIFY_API_URL=https://your-instance.com/v1
OPENAI_API_KEY=your_openai_key

# 音声サービス設定
AIVISSPEECH_API_URL=http://localhost:50021
WHISPER_API_URL=http://localhost:8080

# ボット設定
DEFAULT_RECORDING_DURATION=10
LOG_LEVEL=INFO
```

### 4. 外部サービスの起動

ボットを起動する前に、必要な外部サービスを起動してください：

#### AivisSpeech (VOICEVOX) - 日本語TTS

```bash
# Docker でVOICEVOXエンジンを起動
docker run -d -p 50021:50021 --name voicevox voicevox/voicevox_engine:latest

# 起動確認
curl http://localhost:50021/speakers
```

#### go-whisper - 音声認識

```bash
# go-whisperのインストールと起動
# 詳細: https://github.com/mutablelogic/go-whisper

# Go 1.22+ が必要
go install github.com/mutablelogic/go-whisper/cmd/whisper-server@latest

# サーバー起動 (デフォルトポート: 8080)
whisper-server

# 起動確認
curl http://localhost:8080/v1/models
```

#### Ollama (オプション) - ローカルLLM

```bash
# Ollamaのインストール
curl -fsSL https://ollama.ai/install.sh | sh

# サービス起動
ollama serve

# 日本語対応モデルのダウンロード
ollama pull qwen2.5:7b

# 起動確認
curl http://localhost:11434/api/tags
```

### 5. ボットの起動

#### 開発モード (推奨)

Air を使用した自動再起動機能付きの開発モード：

```bash
cd src/bot-go
./start_watch.sh
```

#### プロダクションモード

```bash
cd src/bot-go
go build -o discord-bot cmd/bot/main.go
./discord-bot
```

### 6. Discord サーバーへの招待

1. Discord Developer Portal でアプリケーションを選択
2. 「OAuth2」→「URL Generator」に移動
3. **Scopes**: `bot`, `applications.commands` を選択
4. **Bot Permissions**: 必要な権限を選択
5. 生成されたURLでDiscordサーバーにボットを招待

## ✅ 動作確認

### 基本動作の確認

1. Discordサーバーでボットがオンラインになっていることを確認
2. `/ping` コマンドを実行してボットが応答することを確認
3. ボイスチャンネルに参加して `/join` コマンドを実行
4. `/record` または音声での自動録音をテスト

### ログの確認

```bash
# ログファイルの確認
tail -f logs/bot.log

# エラーログの確認
grep -i error logs/bot.log
```

## 🔧 トラブルシューティング

### よくある問題

#### 1. Opus ライブラリエラー
```
Error: opus library not found
```

**解決方法**:
```bash
# Ubuntu/Debian
sudo apt-get install libopus-dev

# macOS
brew install opus
```

#### 2. 外部サービス接続エラー
```
Error: connection refused to localhost:50021
```

**解決方法**:
```bash
# サービスの起動状態を確認
docker ps
curl http://localhost:50021/speakers  # VOICEVOX
curl http://localhost:8080/v1/models  # go-whisper
curl http://localhost:11434/api/tags  # Ollama
```

#### 3. Discord 接続エラー
```
Error: invalid bot token
```

**解決方法**:
- Bot Token が正しく設定されているか確認
- `.env` ファイルの形式が正しいか確認
- Bot に必要な権限が付与されているか確認

### サポート

問題が解決しない場合は：
- [GitHub Issues](https://github.com/g-kari/discord-friend/issues) で報告
- [トラブルシューティングガイド](troubleshooting.html) を参照
- ログファイル (`logs/bot.log`) の内容を確認

## 次のステップ

- [開発ガイド](development.html) - 開発環境の詳細設定
- [API リファレンス](api-reference.html) - コマンドとAPI仕様
- [CLAUDE.md](https://github.com/g-kari/discord-friend/blob/main/CLAUDE.md) - 技術詳細
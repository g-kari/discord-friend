---
layout: page
title: "トラブルシューティング"
permalink: /troubleshooting/
---

# トラブルシューティング

Discord AI Voice Bot の一般的な問題と解決方法について説明します。

## 🔧 基本的なトラブルシューティング

### 1. ボットが起動しない

#### 症状
```
Failed to create bot: invalid bot token
```

#### 原因と対処法

**原因 1: Bot Token が正しくない**
```bash
# .env ファイルを確認
cat .env | grep DISCORD_BOT_TOKEN

# Discord Developer Portal でトークンを再生成
# https://discord.com/developers/applications
```

**原因 2: 環境変数が読み込まれていない**
```bash
# .env ファイルの場所を確認
ls -la .env

# 権限を確認
chmod 600 .env

# 環境変数の読み込みを確認
export $(grep -v '^#' .env | xargs)
go run cmd/bot/main.go
```

### 2. 外部サービス接続エラー

#### 症状
```
Error: connection refused to localhost:50021
Error: whisper API not available
Error: ollama connection failed
```

#### 対処法

**VOICEVOX (AivisSpeech) の確認**
```bash
# サービスの起動状態確認
docker ps | grep voicevox

# サービス起動
docker run -d -p 50021:50021 --name voicevox voicevox/voicevox_engine:latest

# 接続テスト
curl http://localhost:50021/speakers
```

**go-whisper の確認**
```bash
# プロセス確認
ps aux | grep whisper

# ポート確認
netstat -tulpn | grep 8080

# サービス起動
whisper-server &

# 接続テスト
curl http://localhost:8080/v1/models
```

**Ollama の確認**
```bash
# サービス確認
ollama ps

# サービス起動
ollama serve &

# モデル確認
ollama list

# 接続テスト
curl http://localhost:11434/api/tags
```

## 🎤 音声関連の問題

### 1. 音声が録音されない

#### 症状
- `/record` コマンドが無反応
- VADが音声を検出しない
- 録音ファイルが空

#### 診断手順

**1. Discord 接続の確認**
```bash
# ログでDiscord音声接続を確認
grep -i "voice" logs/bot.log | tail -10

# ボイスチャンネル参加の確認
grep -i "join" logs/bot.log | tail -5
```

**2. Opus ライブラリの確認**
```bash
# Opus開発ライブラリの確認
dpkg -l | grep opus  # Ubuntu/Debian
brew list | grep opus  # macOS

# ライブラリの再インストール
sudo apt-get install libopus-dev  # Ubuntu/Debian
brew install opus  # macOS
```

**3. 音声権限の確認**
- Discord サーバーでボットの権限確認
- Voice Permissions: Connect, Speak, Use Voice Activity

#### 対処法

**VADログの有効化**
```bash
# .env でデバッグレベルを設定
LOG_LEVEL=DEBUG

# VAD関連ログの確認
tail -f logs/bot.log | grep -E "(VAD|VOICE|OPUS)"
```

**手動録音テスト**
```bash
# 10秒間の手動録音テスト
/record duration:10

# ログで録音プロセス確認
grep -A 5 -B 5 "Recording" logs/bot.log
```

### 2. 音声認識が機能しない

#### 症状
```
Error: whisper transcription failed
Error: audio format not supported
```

#### 対処法

**go-whisper の設定確認**
```bash
# go-whisper サーバーのログ確認
journalctl -u whisper-server -f

# モデルの確認と再ダウンロード
whisper-server --download-models

# 音声ファイル形式の確認
file tmp/recording.wav
ffprobe tmp/recording.wav
```

**WAVファイルの手動テスト**
```bash
# 生成されたWAVファイルの確認
ls -la tmp/recording_*.wav

# 手動でgo-whisper API呼び出し
curl -X POST http://localhost:8080/v1/audio/transcriptions \
  -H "Content-Type: multipart/form-data" \
  -F "file=@tmp/recording.wav" \
  -F "model=whisper-1" \
  -F "language=ja"
```

### 3. TTS (音声合成) が機能しない

#### 症状
```
Error: TTS synthesis failed
Error: VOICEVOX API error
```

#### 対処法

**VOICEVOX の詳細確認**
```bash
# VOICEVOX コンテナログ確認
docker logs voicevox

# 利用可能な話者確認
curl http://localhost:50021/speakers | jq .

# 手動音声合成テスト
curl -X POST "http://localhost:50021/audio_query?text=テスト&speaker=3" | \
curl -X POST "http://localhost:50021/synthesis?speaker=3" \
  -H "Content-Type: application/json" \
  -d @- \
  --output test.wav
```

## 🤖 AI機能の問題

### 1. LLM応答が取得できない

#### 症状
```
Error: ollama request failed
Error: LLM timeout
```

#### 対処法

**Ollama の診断**
```bash
# Ollama サーバーの状態確認
ollama ps

# モデル一覧確認
ollama list

# モデルの再プル
ollama pull qwen2.5:7b

# 手動チャットテスト
ollama run qwen2.5:7b "こんにちは"
```

**Dify API の確認**
```bash
# Dify API接続テスト
curl -X POST "${DIFY_API_URL}/chat-messages" \
  -H "Authorization: Bearer ${DIFY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"inputs": {}, "query": "テスト", "user": "test"}'
```

### 2. Vision AI が機能しない

#### 症状
```
Error: screenshot capture failed
Error: vision analysis failed
```

#### 対処法

**スクリーンショット機能の確認**
```bash
# X11 サーバーの確認 (Linux)
echo $DISPLAY
xhost +

# スクリーンショット権限の確認 (macOS)
# システム環境設定 > セキュリティとプライバシー > 画面収録

# 手動スクリーンショットテスト
import -window root screenshot.png  # ImageMagick
screencapture -x screenshot.png     # macOS
```

**Vision API の確認**
```bash
# OpenAI Vision API テスト
curl -X POST "https://api.openai.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4-vision-preview",
    "messages": [{"role": "user", "content": [{"type": "text", "text": "この画像について説明してください"}]}]
  }'
```

## 📊 パフォーマンス関連の問題

### 1. 高いCPU使用率

#### 症状
- ボット応答が遅い
- システムが重い
- 音声処理の遅延

#### 対処法

**リソース使用量の確認**
```bash
# CPU・メモリ使用量確認
top -p $(pgrep discord-bot)
htop

# Goroutine数の確認
go tool pprof http://localhost:6060/debug/pprof/goroutine
```

**最適化設定**
```bash
# .env で処理制限を設定
MAX_CONCURRENT_RECORDINGS=2
VAD_BUFFER_SIZE=1024
DEFAULT_RECORDING_DURATION=5  # 録音時間短縮
```

### 2. メモリリーク

#### 症状
```
runtime: out of memory
fatal error: runtime: out of memory
```

#### 対処法

**メモリプロファイリング**
```bash
# メモリプロファイル取得
go tool pprof http://localhost:6060/debug/pprof/heap

# メモリ使用量の確認
(pprof) top10
(pprof) list main.main
```

**一時的な対処**
```bash
# ボットの再起動
pkill discord-bot
./start_watch.sh

# システムメモリの確認
free -h
sudo swapoff -a && sudo swapon -a  # スワップクリア
```

## 🐛 開発時の問題

### 1. ホットリロードが機能しない

#### 症状
- ファイル変更が反映されない
- Air が応答しない

#### 対処法

**Air設定の確認**
```bash
# .air.toml の設定確認
cat .air.toml

# Air プロセスの確認
ps aux | grep air

# Air の再起動
pkill air
./start_watch.sh
```

### 2. ビルドエラー

#### 症状
```
# command-line-arguments
./main.go:10:2: no required module provides package github.com/...
```

#### 対処法

**依存関係の確認と修正**
```bash
# go.mod の確認
cat go.mod

# 依存関係の更新
go mod tidy
go mod download

# キャッシュクリア
go clean -modcache
go mod download
```

## 📋 診断スクリプト

### 総合診断スクリプト

```bash
#!/bin/bash
# diagnostic.sh - 総合診断スクリプト

echo "=== Discord AI Voice Bot 診断 ==="

# 1. 基本環境確認
echo "1. 基本環境確認"
go version
docker --version

# 2. 必要なライブラリ確認
echo "2. ライブラリ確認"
pkg-config --exists opus && echo "✅ Opus OK" || echo "❌ Opus NG"

# 3. サービス確認
echo "3. 外部サービス確認"
curl -s http://localhost:50021/speakers > /dev/null && echo "✅ VOICEVOX OK" || echo "❌ VOICEVOX NG"
curl -s http://localhost:8080/v1/models > /dev/null && echo "✅ go-whisper OK" || echo "❌ go-whisper NG"
curl -s http://localhost:11434/api/tags > /dev/null && echo "✅ Ollama OK" || echo "❌ Ollama NG"

# 4. 設定ファイル確認
echo "4. 設定ファイル確認"
[ -f .env ] && echo "✅ .env存在" || echo "❌ .env不存在"
[ -f logs/bot.log ] && echo "✅ ログファイル存在" || echo "❌ ログファイル不存在"

# 5. プロセス確認
echo "5. プロセス確認"
pgrep discord-bot > /dev/null && echo "✅ ボット起動中" || echo "❌ ボット停止中"

echo "=== 診断完了 ==="
```

### ログ解析スクリプト

```bash
#!/bin/bash
# log_analysis.sh - ログ解析スクリプト

echo "=== 直近のエラー ==="
grep -i error logs/bot.log | tail -5

echo "=== VAD統計 ==="
grep "VAD Statistics" logs/bot.log | tail -1

echo "=== 音声処理統計 ==="
grep -E "(Recording|Transcription|TTS)" logs/bot.log | tail -10

echo "=== パフォーマンス情報 ==="
grep -E "(Memory|CPU|Goroutine)" logs/bot.log | tail -5
```

## 🆘 サポートリソース

### 問題報告時の情報

問題を報告する際は以下の情報を提供してください：

1. **環境情報**
   - OS とバージョン
   - Go バージョン
   - Docker バージョン

2. **エラーメッセージ**
   - 完全なエラーログ
   - 発生時刻
   - 再現手順

3. **設定情報**
   - .env ファイル（機密情報除く）
   - 使用しているモデル
   - 外部サービスの状態

### サポートチャンネル

- **[GitHub Issues](https://github.com/g-kari/discord-friend/issues)** - バグ報告・機能要求
- **[GitHub Discussions](https://github.com/g-kari/discord-friend/discussions)** - 質問・討論
- **[プロジェクトドキュメント](index.html)** - 基本的な使用方法

### 緊急時の対処

**ボットの完全リセット**
```bash
# 1. 全プロセス停止
pkill discord-bot
docker stop voicevox
pkill whisper-server
pkill ollama

# 2. ログクリア
rm -f logs/bot.log
rm -f tmp/recording_*.wav

# 3. サービス再起動
docker start voicevox
ollama serve &
whisper-server &

# 4. ボット再起動
./start_watch.sh
```
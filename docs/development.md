---
layout: page
title: "開発ガイド"
permalink: /development/
---

# 開発ガイド

Discord AI Voice Bot の開発環境構築と開発ワークフローについて説明します。

## 🛠️ 開発環境セットアップ

### 前提条件

- Go 1.21+
- Docker & Docker Compose
- Git
- エディタ/IDE (VS Code推奨)

### 開発用ツールのインストール

```bash
# Air (ホットリロードツール)
go install github.com/cosmtrek/air@latest

# golangci-lint (コード解析)
go install github.com/golangci-lint/golangci-lint/cmd/golangci-lint@latest

# gofumpt (コードフォーマッター)
go install mvdan.cc/gofumpt@latest
```

## 📁 プロジェクト構成

```
src/bot-go/
├── cmd/bot/              # メインエントリーポイント
│   └── main.go
├── internal/             # 内部パッケージ (非公開API)
│   ├── ai/              # AI サービス統合
│   │   ├── whisper.go   # 音声認識
│   │   ├── llm.go       # 大規模言語モデル
│   │   ├── tts.go       # 音声合成
│   │   └── vision.go    # 画像解析
│   ├── bot/             # ボットコアロジック
│   │   ├── bot.go       # メインボット構造体
│   │   ├── handlers.go  # コマンドハンドラー
│   │   └── events.go    # イベントハンドラー
│   ├── config/          # 設定管理
│   │   └── config.go
│   └── voice/           # 音声処理システム
│       ├── vad.go       # Voice Activity Detection
│       ├── recorder.go  # 音声録音
│       ├── player.go    # 音声再生
│       └── logger.go    # 音声ログ
├── .air.toml            # Air設定ファイル
├── .env.example         # 環境変数テンプレート
├── go.mod               # Go依存関係
├── go.sum               # 依存関係チェックサム
├── start_watch.sh       # 開発用起動スクリプト
└── logs/                # ログディレクトリ
    └── bot.log
```

## 🚀 開発ワークフロー

### 1. 開発サーバーの起動

```bash
cd src/bot-go

# ホットリロードで開発サーバーを起動
./start_watch.sh

# または直接Airを使用
air
```

### 2. コード変更とテスト

1. **コード編集**: エディタでGoファイルを編集
2. **自動再起動**: Airが変更を検出して自動でボットを再起動
3. **Discord でテスト**: ボットコマンドを実行して動作確認
4. **ログ確認**: `logs/bot.log` でデバッグ情報を確認

### 3. コード品質チェック

```bash
# コードフォーマット
go fmt ./...
gofumpt -w .

# リント実行
golangci-lint run

# テスト実行
go test ./...

# ビルド確認
go build -o discord-bot cmd/bot/main.go
```

## 🎤 音声機能の開発

### Voice Activity Detection (VAD) システム

VADシステムは自動音声検出の中核機能です：

```go
// internal/voice/vad.go
type VADRecorder struct {
    isRecording     bool
    voiceBuffer     [][]byte
    lastVoiceTime   time.Time
    silenceThreshold time.Duration // 1秒
    minRecordingTime time.Duration // 200ms
}
```

#### 主要な処理フロー

1. **パケット解析**: Discord UDPパケットのサイズ分析
2. **音声検出**: パケットサイズ >50バイト = 音声
3. **録音開始**: 音声検出時に自動録音開始
4. **無音検出**: 1秒間無音で録音停止
5. **音声処理**: Opus → PCM → WAV変換

### 音声録音のデバッグ

```go
// 詳細なログ出力例
logger.Debug("VAD: Voice packet detected", 
    "size", len(packet.Opus), 
    "timestamp", packet.Timestamp)

logger.Info("VAD: Recording stopped", 
    "duration", recordingDuration,
    "packets", len(voiceBuffer))
```

### ログ分析コマンド

```bash
# VAD関連ログの確認
grep -E "(VAD|VOICE|OPUS)" logs/bot.log | tail -20

# エラーログの確認  
grep -E "(ERROR|FAILED)" logs/bot.log

# リアルタイムログ確認
tail -f logs/bot.log | grep -E "(VAD|VOICE)"
```

## 🧪 テストとデバッグ

### 単体テスト

```bash
# 全テスト実行
go test ./...

# 特定パッケージのテスト
go test ./internal/voice

# カバレッジ付きテスト
go test -cover ./...

# ベンチマークテスト
go test -bench=. ./internal/voice
```

### 統合テスト

Discord環境での統合テスト：

1. **基本コマンド**: `/ping`, `/join`, `/leave`
2. **音声機能**: `/record`, `/listen` 
3. **AI機能**: 音声→テキスト→AI応答→TTS
4. **画面解析**: `/screenshot`, `/screen_share`

### デバッグ設定

`.env` ファイルでデバッグレベルを調整：

```env
LOG_LEVEL=DEBUG  # TRACE, DEBUG, INFO, WARN, ERROR
```

## 🔧 開発ツールとスクリプト

### Air設定 (.air.toml)

```toml
[build]
  cmd = "go build -o tmp/main cmd/bot/main.go"
  bin = "tmp/main"
  full_bin = ""
  include_ext = ["go", "tpl", "tmpl", "html"]
  exclude_dir = ["assets", "tmp", "vendor", "frontend/node_modules"]
  include_dir = []
  exclude_file = []
  delay = 1000
  stop_on_root = true
  log = "air.log"

[color]
  main = "magenta"
  watcher = "cyan"
  build = "yellow"
  runner = "green"
```

### 開発支援スクリプト

```bash
# 開発環境の完全セットアップ
./scripts/setup-dev.sh

# ローカルLLMの起動
./scripts/deploy-local-llm.sh

# リンターとフォーマッターの実行
./scripts/lint-fix.sh
```

## 📊 パフォーマンス最適化

### プロファイリング

```bash
# CPUプロファイル
go test -cpuprofile=cpu.prof -bench=.

# メモリプロファイル  
go test -memprofile=mem.prof -bench=.

# プロファイル解析
go tool pprof cpu.prof
```

### 音声処理の最適化

- **Opus デコード**: gopus ライブラリの効率的な使用
- **PCM バッファリング**: 適切なバッファサイズの設定
- **並行処理**: Goroutineによる非同期処理
- **メモリ管理**: 音声バッファの適切な解放

## 🔄 CI/CD パイプライン

### GitHub Actions

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-go@v3
        with:
          go-version: '1.21'
      - run: go mod download
      - run: go test ./...
      - run: golangci-lint run
```

### プリコミットフック

```bash
# .git/hooks/pre-commit
#!/bin/sh
set -e

echo "Running Go tests..."
go test ./...

echo "Running linter..."
golangci-lint run

echo "Checking formatting..."
gofumpt -d .
```

## 📝 コーディング規約

### Go コーディングスタイル

- [Effective Go](https://golang.org/doc/effective_go.html) に準拠
- `gofumpt` によるコードフォーマット
- `golangci-lint` による静的解析

### コミットメッセージ

```
feat: add voice activity detection system
fix: resolve opus decoding issues in VAD
refactor: improve error handling in voice recorder
docs: update development guide with VAD details
```

### エラーハンドリング

```go
// 推奨: 詳細なエラー情報
if err != nil {
    return fmt.Errorf("failed to decode opus audio: %w", err)
}

// 推奨: ログとエラー情報の両方
logger.Error("VAD recording failed", "error", err, "duration", recordDuration)
return fmt.Errorf("VAD recording error: %w", err)
```

## 🚀 デプロイメント

### 本番環境ビルド

```bash
# 本番用バイナリビルド
CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -o discord-bot cmd/bot/main.go

# Docker イメージビルド
docker build -t discord-bot .
```

### 環境別設定

- **開発**: `.env` (ローカル設定)
- **ステージング**: `.env.staging` 
- **本番**: 環境変数またはSecret管理

## 📚 参考リソース

### 内部ドキュメント
- [CLAUDE.md](https://github.com/g-kari/discord-friend/blob/main/CLAUDE.md) - 技術詳細
- [scripts/README.md](https://github.com/g-kari/discord-friend/blob/main/scripts/README.md) - スクリプト使用方法

### 外部リソース
- [DiscordGo Documentation](https://pkg.go.dev/github.com/bwmarrin/discordgo)
- [go-whisper](https://github.com/mutablelogic/go-whisper)
- [Air Live Reload](https://github.com/cosmtrek/air)

### 開発支援
- [GitHub Issues](https://github.com/g-kari/discord-friend/issues) - バグ報告・機能要求
- [GitHub Discussions](https://github.com/g-kari/discord-friend/discussions) - 技術的な質問・討論
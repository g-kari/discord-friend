---
layout: home
title: "Discord AI Voice Bot"
---

# Discord AI Voice Bot (Go Implementation)

日本語対応のDiscord AIボイスボット - 最新のGo実装による高性能なボイスチャット機能

## 🎯 主要機能

### 🎤 高品質音声処理
- **リアルタイム音声認識**: go-whisperによる日本語音声認識
- **Voice Activity Detection (VAD)**: 自動音声検出システム  
- **本格的Discord音声処理**: gopusライブラリによる実際のOpus音声デコード
- **日本語TTS**: AivisSpeech (VOICEVOX) による自然な音声合成

### 🤖 AI統合
- **ローカルLLM対応**: Ollama統合によるプライベートAI
- **クラウドAI対応**: Dify API, OpenAI統合
- **Vision AI**: 画面共有・スクリーンショット解析
- **マルチモーダル**: テキスト・音声・画像の総合的な処理

### ⚡ 高性能アーキテクチャ
- **Go言語実装**: 高速・軽量・並行処理対応
- **ホットリロード**: Air による開発時自動再起動
- **クリーンアーキテクチャ**: 保守性の高い設計
- **Docker対応**: 簡単なデプロイメント

## 🚀 クイックスタート

```bash
# 1. リポジトリをクローン
git clone https://github.com/g-kari/discord-friend.git
cd discord-friend

# 2. Go実装をセットアップ
cd src/bot-go
cp .env.example .env
# .envファイルを編集してDISCORD_BOT_TOKENなどを設定

# 3. 依存関係をインストール
go mod download
sudo apt-get install libopus-dev  # Ubuntu/Debian
# brew install opus              # macOS

# 4. 開発モードで起動 (自動再起動対応)
./start_watch.sh
```

## 📚 ドキュメント

### 基本ガイド
- [**インストール・セットアップ**](getting-started.html) - 環境構築から初回起動まで
- [**開発ガイド**](development.html) - 開発環境の構築と開発ワークフロー
- [**API リファレンス**](api-reference.html) - コマンドとAPI仕様
- [**トラブルシューティング**](troubleshooting.html) - よくある問題と解決方法

### 技術詳細
- [**CLAUDE.md**](https://github.com/g-kari/discord-friend/blob/main/CLAUDE.md) - 開発者向け技術詳細ガイド
- [**OLLAMA_TIPS.md**](https://github.com/g-kari/discord-friend/blob/main/OLLAMA_TIPS.md) - Ollama最適化ガイド
- [**scripts/README.md**](https://github.com/g-kari/discord-friend/blob/main/scripts/README.md) - 開発支援スクリプト

## 🎮 Discord コマンド

| コマンド | 説明 |
|---------|------|
| `/join` | ボイスチャンネルに参加（VAD自動開始） |
| `/leave` | ボイスチャンネルから退出 |
| `/record` | 手動音声録音（10秒間） |
| `/listen` | Voice Activity Detection 開始/停止 |
| `/screenshot` | スクリーンショット撮影・解析 |
| `/screen_share` | 画面共有解析の開始/停止 |
| `/ping` | ボットのステータス確認 |

## 🏗️ システム構成

```
src/bot-go/
├── cmd/bot/          # メインエントリーポイント
├── internal/         # 内部パッケージ
│   ├── ai/          # AI サービス (Whisper, LLM, TTS, Vision)
│   ├── bot/         # ボットコアロジック・ハンドラー
│   ├── config/      # 設定管理
│   └── voice/       # 音声録音・VADシステム
├── .air.toml        # Air 設定
├── .env.example     # 環境変数テンプレート
├── go.mod           # Go 依存関係
└── start_watch.sh   # 開発用スクリプト
```

## 🔧 必要な外部サービス

1. **AivisSpeech (VOICEVOX)**: 日本語TTS エンジン
   - ポート: 50021
   - 起動: `docker run -p 50021:50021 voicevox/voicevox_engine:latest`

2. **Ollama**: ローカルLLM (オプション)
   - ポート: 11434  
   - 起動: `ollama serve && ollama pull qwen2.5:7b`

3. **go-whisper**: 音声認識
   - ポート: 8080
   - GitHub: [mutablelogic/go-whisper](https://github.com/mutablelogic/go-whisper)

## 💡 貢献

プロジェクトへの貢献を歓迎します！

- **[GitHub Issues](https://github.com/g-kari/discord-friend/issues)** - バグ報告・機能要求
- **[Pull Requests](https://github.com/g-kari/discord-friend/pulls)** - コード改善・新機能
- **[GitHub Repository](https://github.com/g-kari/discord-friend)** - ソースコード

## 📄 ライセンス

このプロジェクトはMITライセンスの下で公開されています。
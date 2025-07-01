# Discord AI Voice Bot (Go Implementation)

## 📋 目次 (Table of Contents)

- [概要](#概要) - プロジェクトの概要と主要機能
- [システム構成](#システム構成) - アーキテクチャと技術スタック
- [処理フロー](#処理フロー) - ボットの動作原理
- [🚀 クイックスタート](#-クイックスタート) - 環境構築と起動方法
- [Discord コマンド](#discord-コマンド) - 利用可能なコマンド一覧
- [📚 ドキュメント](#-ドキュメント) - 関連ドキュメントへのリンク
- [🔧 開発・テスト](#-開発テスト) - 開発者向け情報
- [🛠️ トラブルシューティング](#️-トラブルシューティング) - よくある問題と解決法
- [🔒 セキュリティ](#-セキュリティ) - セキュリティに関する注意事項

---

## 概要

このプロジェクトは、**Go言語で実装された高性能なDiscord AI音声ボット**です。
リアルタイムの音声認識（STT）、大規模言語モデル（LLM）、高品質な音声合成（TTS）を統合し、Discordのボイスチャンネルで自然な日本語会話を実現します。

### 主な特徴

- **🎯 Go言語による高性能実装**: 軽量で高速な処理
- **🎤 リアルタイム音声処理**: Discord Opus音声の直接デコード
- **🤖 Voice Activity Detection (VAD)**: 自動音声検出・録音システム  
- **🧠 多様なAI連携**: Ollama（ローカル）、Dify、OpenAI対応
- **🔊 高品質TTS**: AivisSpeech（VOICEVOX）による日本語音声合成
- **📷 スクリーン共有認識**: リアルタイム画面解析
- **👁️ Vision AI**: 画像解析機能（OpenAI Vision、Ollama LLaVA）
- **⚡ ホットリロード**: Air による開発時の自動再起動

---

## システム構成

### Go実装アーキテクチャ

```
src/bot-go/
├── cmd/bot/          # メインエントリーポイント
├── internal/         # 内部パッケージ
│   ├── ai/          # AI サービス (Whisper, LLM, TTS, Vision)
│   ├── bot/         # ボットコアロジックとハンドラー
│   ├── config/      # 設定管理
│   └── voice/       # 音声録音とVADシステム
├── .air.toml        # Air設定ファイル
├── .env.example     # 環境変数テンプレート
├── go.mod           # Go依存関係
└── start_watch.sh   # 開発用スクリプト
```

### 主要技術スタック

- **[discordgo](https://github.com/bwmarrin/discordgo)**: Discord API Go ライブラリ
- **[layeh.com/gopus](https://github.com/layeh/gopus)**: Discord用リアルOpus音声コーデック
- **[Air](https://github.com/cosmtrek/air)**: Go開発用ライブリロード
- **[go-whisper](https://github.com/mutablelogic/go-whisper)**: 音声認識（Whisper Go実装）
- **[Ollama](https://ollama.ai)**: ローカルLLM実行環境
- **[AivisSpeech](https://github.com/Aivis-Project/AivisSpeech)**: 日本語TTS音声合成エンジン

## 処理フロー

このボットは以下の処理フローで動作します：

### 1. 音声認識フロー
```
Discord音声 → UDPパケット → RTP解析 → Opus抽出 → VAD解析
    ↓
音声検出 → 録音開始 → Opusパケットバッファ → 無音検出
    ↓
録音停止 → Opusデコード(gopus) → PCM組み立て → WAV生成
    ↓
go-whisper API → 日本語音声認識 → テキスト出力
```

### 2. AI応答フロー
```
認識テキスト → LLM処理(Ollama/Dify) → AI応答生成
    ↓
AivisSpeech TTS → 音声合成 → Discordボイスチャンネル再生
```

### 3. Voice Activity Detection (VAD)
- **パケット解析**: パケットサイズによる音声/無音判定（>50バイト = 音声）
- **スマートタイミング**: 1秒無音閾値、200ms最小録音、15秒最大録音
- **リアルタイム処理**: 連続音声パケットモニタリング
- **スレッドセーフ**: 同時録音・再生対応

---

## 🚀 クイックスタート

### 1. Go環境のセットアップ

```bash
# Go 1.21+ が必要
go version

# プロジェクトのクローン
git clone https://github.com/g-kari/discord-friend.git
cd discord-friend/src/bot-go
```

### 2. 依存関係のインストール

```bash
# Go モジュールの依存関係をインストール
go mod download

# システム依存関係（Ubuntu/Debian）
sudo apt-get install libopus-dev

# システム依存関係（macOS）
brew install opus
```

### 3. 環境設定

```bash
# 環境変数ファイルをコピー
cp .env.example .env

# .env ファイルを編集（必須項目を設定）
```

#### 必須環境変数
```env
# Discord
DISCORD_BOT_TOKEN=your_discord_bot_token

# AI Services
PREFER_LOCAL_LLM=true
OLLAMA_API_URL=http://localhost:11434
OPENAI_API_KEY=your_openai_key  # 音声認識用

# Voice Services  
AIVISSPEECH_API_URL=http://localhost:50021
WHISPER_API_URL=http://localhost:8080

# Bot Settings
DEFAULT_RECORDING_DURATION=10
LOG_LEVEL=INFO
```

### 4. 外部サービスの起動

```bash
# 1. AivisSpeech (VOICEVOX) を起動
docker run -p 50021:50021 voicevox/voicevox_engine:latest

# 2. Ollama を起動（ローカルLLM用）
ollama serve
ollama pull qwen2.5:7b  # 日本語モデル

# 3. go-whisper を起動（音声認識用）
# 詳細: https://github.com/mutablelogic/go-whisper
```

### 5. ボットの起動

```bash
# 開発モード（自動リロード）
./start_watch.sh

# 直接実行
go run cmd/bot/main.go

# ビルドして実行
go build -o discord-bot cmd/bot/main.go
./discord-bot
```

---

## Discord コマンド

### スラッシュコマンド
- `/join` - ボイスチャンネルに参加（VAD自動開始）
- `/leave` - ボイスチャンネルから退出
- `/record` - 手動音声録音（10秒間）
- `/listen` - Voice Activity Detection の開始/停止
- `/screenshot` - スクリーンショット撮影・解析
- `/screen_share` - スクリーン共有解析の開始/停止  
- `/ping` - ボットの状態確認

---

## 📚 ドキュメント

### 開発者向けドキュメント
- **[CLAUDE.md](CLAUDE.md)** - Claude AI向け開発ガイド（技術詳細、アーキテクチャ、デバッグ方法）
- **[OLLAMA_TIPS.md](OLLAMA_TIPS.md)** - Ollama最適化・活用ガイド
- **[scripts/README.md](scripts/README.md)** - 開発支援スクリプトの使用方法

### プロジェクト管理
- **[GitHub Issues](https://github.com/g-kari/discord-friend/issues)** - バグ報告・機能要求
- **[GitHub Pages](https://g-kari.github.io/discord-friend/)** - 詳細なドキュメント

---

## 🔧 開発・テスト

### 開発コマンド
```bash
cd src/bot-go

# 依存関係のインストール
go mod download

# ホットリロード開発サーバー
./start_watch.sh

# 直接実行
go run cmd/bot/main.go

# ビルド
go build -o discord-bot cmd/bot/main.go

# テスト実行
go test ./...

# コードフォーマット
go fmt ./...

# リント（golangci-lintが必要）
golangci-lint run
```

### 開発ワークフロー
1. **開発サーバー起動**: `./start_watch.sh` で自動リロード
2. **コード変更**: Go コードを編集・保存
3. **Discord テスト**: Air でボットが自動再起動
4. **ログ確認**: `logs/bot.log` で詳細デバッグ
5. **音声テスト**: `/join` で参加後、話すかけるか `/record` で手動録音
6. **変更コミット**: 頻繁にわかりやすいメッセージでコミット

### ログとデバッグ
```bash
# 最近の音声関連ログを確認
tail -100 logs/bot.log | grep -E "(VOICE|OPUS|WAV|WHISPER|VAD)"

# リアルタイムログ監視
tail -f logs/bot.log

# エラーパターンの確認
grep -n "ERROR\|FAILED\|❌" logs/bot.log | tail -20

# VAD統計の分析
grep "VAD Statistics" logs/bot.log
```

---

## ⚠️ 重要事項

### システム要件
1. **Go 1.21+** が必要
2. **libopus-dev** システムパッケージ（gopus用）
3. **適切な権限** - スクリーンキャプチャに必要
4. **外部サービス** - AivisSpeech、go-whisper、Ollama
5. **API キー** - `.env` ファイルに設定（リポジトリにコミットしない）

### パフォーマンス
- **リアル音声処理**: layeh.com/gopus によるDiscord音声の直接デコード
- **VAD ログ**: `logs/bot.log` にパケットレベルの詳細デバッグ情報
- **スレッドセーフ**: 同時録音・再生処理に対応

---

## 🛠️ トラブルシューティング

### 音声関連の問題
- **音声が認識されない**: `/join` コマンドでボイスチャンネルに参加してから話す
- **Opus デコードエラー**: gopus ライブラリと libopus-dev の確認
- **go-whisper API エラー**: go-whisper がポート 8080 で動作していることを確認

### 接続の問題  
- **ボット反応なし**: ログでUDP接続とreflection警告を確認
- **ビルドエラー**: 通常はインポートや依存関係の問題、Air の出力を確認

### その他の問題
1. ボットを再起動する
2. 依存関係を最新バージョンに更新する
3. [GitHub Issues](https://github.com/g-kari/discord-friend/issues) で同様の問題を確認する

---

## 🔒 セキュリティ

### 機密情報の保護

**⚠️ 重要**: APIキーなどの機密情報をリポジトリにコミットしないでください。

```bash
# Git 履歴の機密情報チェック
python scripts/check_git_secrets.py

# pre-commit フックの設定
ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
```

### セキュリティベストプラクティス
1. **環境変数の使用**: 機密情報は `.env` ファイルに保存
2. **`.gitignore` 設定**: `.env` ファイルをGit管理対象外に
3. **サンプル値の使用**: `.env.example` にはサンプル値のみ
4. **定期ローテーション**: 本番環境のAPIキー定期更新

詳細は [scripts/README.md](scripts/README.md) を参照してください。

---

## 📄 ライセンス

このプロジェクトは複数のオープンソースライブラリを使用しています：

- **[discordgo](https://github.com/bwmarrin/discordgo)**: BSD-3-Clause
- **[gopus](https://github.com/layeh/gopus)**: MPL-2.0  
- **[AivisSpeech](https://github.com/Aivis-Project/AivisSpeech)**: Apache-2.0
- **[Ollama](https://ollama.ai)**: MIT
- **[go-whisper](https://github.com/mutablelogic/go-whisper)**: Apache-2.0

---

## 🔗 参考リンク

### 公式ドキュメント
- **[Discord Developer Portal](https://discord.com/developers/docs)** - Discord API 公式ドキュメント
- **[Ollama GitHub](https://github.com/ollama/ollama)** - Ollama 公式リポジトリ
- **[AivisSpeech GitHub](https://github.com/Aivis-Project/AivisSpeech)** - AivisSpeech 公式リポジトリ
- **[go-whisper GitHub](https://github.com/mutablelogic/go-whisper)** - go-whisper 公式リポジトリ

### プロジェクトドキュメント
- **[GitHub Pages](https://g-kari.github.io/discord-friend/)** - 詳細なドキュメントとガイド
- **[OWASP セキュアコーディング](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/)** - セキュリティガイドライン
- **[GitHub セキュリティ](https://docs.github.com/ja/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)** - 機密データ削除方法

---

## 💡 貢献

プロジェクトへの貢献を歓迎します！

1. **Issue 作成**: バグ報告や機能要求は [GitHub Issues](https://github.com/g-kari/discord-friend/issues)
2. **Pull Request**: コードの改善や新機能の追加
3. **ドキュメント**: ドキュメントの改善やサンプルの追加
4. **テスト**: テストケースの追加

詳細な貢献方法については [CLAUDE.md](CLAUDE.md) の「Git Commit Guidelines」を参照してください。

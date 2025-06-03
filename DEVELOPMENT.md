# Discord AI Avatar Bot - 開発ガイド

このドキュメントは開発者向けの技術情報を提供します。一般的な情報と使用方法については、メインの README.md を参照してください。

## プロジェクト構造

```
src/bot/
├── discord_aiavatar_complete.py  # メインボットファイル
├── config.py                     # 設定と環境変数
├── models/                       # データモデル
│   └── database.py               # データベース操作
├── services/                     # サービス統合
└── requirements.txt              # Python依存関係
```

## 主要コンポーネント

### Discord Bot

メインの Discord ボットは `discord_aiavatar_complete.py` に実装されています。Discord API とのインターフェースに discord.py を使用しています。

主な機能：
- 音声認識と処理
- AI サービスとの統合
- ユーザー設定管理
- ボイスチャンネルでの相互作用

### 設定

設定は `config.py` と `.env` ファイルから読み込まれる環境変数を通じて管理されます。

必要な環境変数：
- `DISCORD_BOT_TOKEN`: Discord ボットトークン
- `DIFY_API_KEY`: Dify AI の API キー
- `DIFY_API_URL`: Dify API の URL
- `OPENAI_API_KEY`: 音声認識用の OpenAI API キー
- `AIVISSPEECH_API_URL`: AivisSpeech API の URL（デフォルト: http://localhost:50021）

オプションの環境変数：
- `MCP_SERVERS`: 起動時に自動接続するサーバーとボイスチャンネルの JSON 形式の設定。
  例: `{"サーバー名": ["ボイスチャンネル1", "ボイスチャンネル2"]}`

### データベース

ボットはデータ保存に SQLite を使用します。データベースファイルはデフォルトで `aiavatar_bot.db` です。

主なテーブル：
- `recording_settings`: ユーザーの音声録音設定
- `user_settings`: 一般的なユーザー設定と設定

## 開発ワークフロー

詳細な開発環境のセットアップとワークフローについては、[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## アーキテクチャ

ボットは以下の主要な実行フローに従います：

1. **音声認識**：
   - ユーザーがボイスチャンネルで話す
   - 音声がキャプチャされ処理される
   - OpenAI を使用して音声がテキストに変換される
   - テキストが処理のために AI サービスに送信される

2. **AI 応答**：
   - AI サービスからの応答が処理される
   - AivisSpeech を使用してテキストが音声に変換される
   - 音声がボイスチャンネルで再生される

3. **コマンド処理**：
   - ユーザーは Discord スラッシュコマンドでボットを制御できる
   - コマンドは設定を管理し、アクションをトリガーし、情報を問い合わせる

4. **自動接続機能**：
   - ボットは起動時に指定されたボイスチャンネルに自動的に接続できる
   - `MCP_SERVERS` 環境変数を通じて設定される
   - ボットが特定のチャンネルでアクティブである必要がある本番環境に役立つ
---
layout: default
title: 開発ガイド
nav_order: 2
description: "Discord AI Voice Bot - 開発ガイド"
permalink: /development/
---

# 開発ガイド
{: .fs-9 }

Discord AI Voice Botの開発に関する技術情報
{: .fs-6 .fw-300 }

このドキュメントは開発者向けの技術情報を提供します。一般的な情報と使用方法については、[ホームページ](../index.md)を参照してください。

## プロジェクト構造

```
src/bot/
├── discord_aiavatar_complete.py  # メインボットファイル
├── config.py                     # 設定と環境変数
├── models/                       # データモデル
│   └── database.py               # データベース操作
├── services/                     # サービス統合
└── requirements.txt              # Pythonの依存パッケージ
```

## 主要コンポーネント

### Discord Bot

メインのDiscordボットは `discord_aiavatar_complete.py` に実装されています。Discord APIとのインターフェースには discord.py を使用しています。

主な機能：
- 音声認識と処理
- AIサービスとの連携
- ユーザー設定管理
- ボイスチャンネル操作

### 設定

設定は `config.py` と `.env` ファイルからロードされる環境変数を介して管理されます。

必須環境変数：
- `DISCORD_BOT_TOKEN`: Discord bot トークン
- `DIFY_API_KEY`: Dify AI の API キー
- `DIFY_API_URL`: Dify API の URL
- `OPENAI_API_KEY`: 音声認識用の OpenAI API キー
- `AIVISSPEECH_API_URL`: AivisSpeech API の URL (デフォルト: http://localhost:50021)

オプション環境変数：
- `MCP_SERVERS`: 起動時に自動接続するサーバーとボイスチャンネルの JSON 形式の設定
  例: `{"サーバー名": ["ボイスチャンネル1", "ボイスチャンネル2"]}`

### データベース

ボットはデータ保存のために SQLite を使用しています。データベースファイルはデフォルトで `aiavatar_bot.db` です。

主なテーブル：
- `recording_settings`: 音声録音に関するユーザー設定
- `user_settings`: 一般的なユーザー設定と環境設定

## 開発ワークフロー

詳細な開発環境のセットアップとワークフローについては、[貢献ガイド](../contributing.html)を参照してください。

## アーキテクチャ

このボットは以下の主な実行フローに従っています：

1. **音声認識**:
   - ユーザーがボイスチャンネルで話す
   - 音声がキャプチャされ処理される
   - OpenAIを使用して音声がテキストに変換される
   - テキストがAIサービスに送信される

2. **AI応答**:
   - AIサービスからの応答が処理される
   - テキストがAivisSpeechを使用して音声に変換される
   - 音声がボイスチャンネルで再生される

3. **コマンド処理**:
   - ユーザーはDiscordのスラッシュコマンドでボットを制御できる
   - コマンドは設定の管理、アクションのトリガー、情報の照会などを行う

4. **自動接続機能**:
   - ボットは起動時に指定されたボイスチャンネルに自動的に参加できる
   - `MCP_SERVERS` 環境変数を介して設定
   - ボットが特定のチャンネルでアクティブである必要がある本番環境に役立つ

## ボットの起動方法

### 開発環境

直接Pythonスクリプトを実行します：

```bash
cd src/bot
source .venv/bin/activate  # 仮想環境を有効化
python discord_aiavatar_complete.py
```

### 本番環境

本番環境ではPM2などのプロセスマネージャーを使用してボットを実行することをお勧めします：

```bash
# ecosystem.config.jsを使用して起動
pm2 start ecosystem.config.js
```

PM2の設定は、リポジトリルートの `ecosystem.config.js` で定義されています。

## デバッグ方法

ボットのデバッグには以下の方法が有効です：

1. ログの確認：
   ```bash
   tail -f /path/to/bot/logs.log
   ```

2. 環境変数の確認：
   ```bash
   cd src/bot
   python -c "import config; print(config.MCP_SERVERS)"
   ```

3. データベースの確認：
   ```bash
   sqlite3 aiavatar_bot.db "SELECT * FROM user_settings;"
   ```

## その他の開発リソース

- [MCPサーバー自動接続機能のテストガイド](../features/mcp-servers.html)
- [セキュリティガイドライン](../security.html)
- [貢献ガイド](../contributing.html)
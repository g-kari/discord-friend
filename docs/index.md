---
layout: default
title: ホーム
nav_order: 1
description: "Discord AI Voice Bot - ホーム"
permalink: /
---

# Discord AI Voice Bot
{: .fs-9 }

Dify × AIAvatarKit × AivisSpeech 構成によるAI会話ボイスボット
{: .fs-6 .fw-300 }

[使い方を見る](#クイックスタート){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[GitHubを見る](https://github.com/g-kari/discord-friend){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## 概要

このプロジェクトは、Dify・AIAvatarKit・AivisSpeech を組み合わせて構築する、マルチモーダルなAI会話ボイスボットです。
Discordやメタバース、Webアプリ等のプラットフォームで、音声認識（STT）、大規模言語モデル（LLM）、高品質な音声合成（TTS）を統合的に提供します。

このボットを使用すると、Discord のボイスチャンネルで自然に会話するように AI と対話できます。ユーザーが話し始めると、ボットは音声を自動的に検出して録音し、その内容に基づいて応答します。また、カスタムプロンプトを設定することで、AI の性格や応答スタイルをカスタマイズすることも可能です。

さらに、オプションの MCP（マルチチャンネルプレゼンス）機能を使用すると、ボットが起動時に指定されたサーバーとボイスチャンネルに自動的に参加するよう設定できます。

## システム構成

- **Dify**  
  オープンソースのLLMアプリ開発基盤。プロンプト管理・APIラッパー・ワークフロー設計・外部ツール連携が可能。
  - [Dify公式](https://github.com/langgenius/dify)

- **AIAvatarKit**  
  モジュール型の会話AIフレームワーク。
  - VAD（音声区間検出）、STT（Google/Azure/OpenAI）、LLM（ChatGPT/Gemini/Claude/Dify/LiteLLM）、TTS（VOICEVOX/AivisSpeech/他）を柔軟に組み合わせ可能
  - WebSocket/HTTPでリアルタイム連携
  - メタバースやIoTデバイスにも対応
  - [AIAvatarKit公式](https://github.com/uezo/aiavatarkit)

- **AivisSpeech**  
  高品質な日本語TTSエンジン。AIAvatarKitのTTSバックエンドとして利用可能。
  - [AivisSpeech公式](https://github.com/Aivis-Project/AivisSpeech)

## アーキテクチャ

このボットは以下の主な実行フローに従っています：

1. **音声認識（Voice Recognition）**:
   - ユーザーがボイスチャンネルで話す
   - 音声がキャプチャされ処理される
   - OpenAIを使用して音声がテキストに変換される
   - テキストがAIサービスに送信される

2. **AI応答（AI Response）**:
   - AIサービスからの応答が処理される
   - テキストがAivisSpeechを使用して音声に変換される
   - 音声がボイスチャンネルで再生される

3. **コマンド処理（Command Handling）**:
   - ユーザーはDiscordのテキストコマンドやスラッシュコマンドでボットを制御できる
   - コマンドは設定の管理、アクションのトリガー、情報の照会などを行う

4. **自動参加機能（Auto-Join Feature）**:
   - ボットは起動時に指定されたボイスチャンネルに自動的に参加できる
   - `MCP_SERVERS` 環境変数を介して設定
   - ボットが特定のチャンネルでアクティブである必要がある本番環境に役立つ

## 主な機能

- **ボイスチャンネル常駐型**
- **話し始めたユーザーを検知して自動録音**（無音検知で終了）
- **キーワード検出**（特定キーワードを含む場合のみ応答）
- **会話履歴の永続化**（SQLite）
- **カスタムプロンプト**（ユーザー別にAIの応答スタイル設定）
- **MCPサーバー自動接続機能**（指定したボイスチャンネルに自動参加）

## クイックスタート

### 開発環境のセットアップ

#### オプション 1: Dev Containers を使用する方法（推奨）

このプロジェクトは Dev Containers を使用して一貫した開発環境を提供します：

1. [Visual Studio Code](https://code.visualstudio.com/) をインストール
2. [Remote - Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) 拡張機能をインストール
3. リポジトリをクローンして VS Code で開く
4. プロンプトが表示されたら「Reopen in Container」を選択するか、コマンドパレット (F1) を使用して「Remote-Containers: Reopen in Container」を選択

#### オプション 2: uv を使用したローカル開発

1. uvのインストール（高速パッケージマネージャー）
   ```bash
   # Unixシステム
   curl -LsSf https://astral.sh/uv/install.sh | sh
   
   # Windows (PowerShell)
   powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
   ```

2. セットアップと仮想環境設定
   ```bash
   cd src/bot
   
   # 仮想環境を作成
   uv venv
   
   # 仮想環境を有効化
   # Unixの場合
   source .venv/bin/activate
   # Windowsの場合
   .venv\Scripts\activate
   
   # 依存パッケージのインストール（uvで高速化）
   uv pip install -r requirements.txt
   ```

### 環境変数の設定

```bash
cd src/bot
cp aiavatar_env.example .env
# .envファイルを編集して必要なAPIキーなどを設定
```

#### 必須環境変数

- `DISCORD_BOT_TOKEN`: Discord bot トークン
- `DIFY_API_KEY`: Dify API キー
- `DIFY_API_URL`: Dify API の URL
- `OPENAI_API_KEY`: 音声認識に使用する OpenAI API キー
- `AIVISSPEECH_API_URL`: AivisSpeech API の URL (デフォルト: http://localhost:50021)

#### オプション環境変数

- `MCP_SERVERS`: 起動時に自動接続するサーバーとボイスチャンネルの JSON 形式の設定
  例: `{"サーバー名": ["ボイスチャンネル1", "ボイスチャンネル2"]}`

### Botの起動

```bash
# 直接起動
python src/bot/discord_aiavatar_complete.py

# PM2での起動
pm2 start ecosystem.config.js
```

## 詳細ドキュメント

- [開発ガイド](./development.html) - プロジェクト構造、開発環境のセットアップなど
- [MCPサーバー自動接続機能](./features/mcp-servers.html) - 自動接続機能の詳細と設定方法
- [セキュリティガイドライン](./security.html) - 機密情報の取り扱いと保護に関するガイドライン
- [貢献ガイド](./contributing.html) - プロジェクトへの貢献方法
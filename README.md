# AI会話ボイスボット（Dify × AIAvatarKit × AivisSpeech 構成）

## 概要

このプロジェクトは、Dify・AIAvatarKit・AivisSpeech を組み合わせて構築する、マルチモーダルなAI会話ボイスボットです。
Discordやメタバース、Webアプリ等のプラットフォームで、音声認識（STT）、大規模言語モデル（LLM）、高品質な音声合成（TTS）を統合的に提供します。

---

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

---

## 主な機能

- **ボイスチャンネル常駐型**
- **話し始めたユーザーを検知して自動録音**（無音検知で終了）
- **キーワード検出**（特定キーワードを含む場合のみ応答）
- **会話履歴の永続化**（SQLite）
- **カスタムプロンプト**（ユーザー別にAIの応答スタイル設定）

---

## クイックスタート

### 1. uvのインストール（高速パッケージマネージャー）
```bash
# Unixシステム
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

### 2. セットアップと仮想環境設定
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

### 3. 環境変数の設定

```bash
cd src/bot
cp aiavatar_env.example .env
# .envファイルを編集して必要なAPIキーなどを設定
```

### 4. Botの起動

```bash
# 直接起動
python src/bot/discord_aiavatar_complete.py

# PM2での起動
pm2 start ecosystem.config.js
```

---

## コマンド一覧

- `!join` - ボイスチャンネルに参加
- `!leave` - ボイスチャンネルから退出
- `!set_prompt <プロンプト>` - AIのシステムプロンプトを設定
- `!recording_on [キーワード]` - 録音をオンにし、オプションでキーワードを設定
- `!recording_off` - 録音をオフにする（Botが反応しなくなる）
- `!history_clear` - 会話履歴をクリア

---

## ライセンス

- Dify: Apache-2.0
- AIAvatarKit: Apache-2.0
- AivisSpeech: Apache-2.0

---

## 備考

- 各OSSの詳細なセットアップ・API仕様は公式リポジトリのREADMEを参照してください。
- AIAvatarKitはDifyやAivisSpeech以外のSTT/LLM/TTSサービスとも柔軟に連携できます。
- メタバースやIoTデバイス、Webアプリ等への拡張も容易です。

## セキュリティ対策

### 機密情報の保護

本リポジトリにはAPIキーなどの機密情報が含まれないように注意してください。以下のツールを使用して機密情報の漏洩を防止できます：

- **Git履歴の機密情報チェック**:
  ```bash
  python scripts/check_git_secrets.py
  ```

- **pre-commitフックの設定**:
  ```bash
  # pre-commitフックを.git/hooksディレクトリにリンク
  ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
  ```

詳細な使い方と機密情報の管理ベストプラクティスについては、[セキュリティスクリプトのREADME](scripts/README.md)を参照してください。

---

### 参考リンク

- [Dify公式GitHub](https://github.com/langgenius/dify)
- [AIAvatarKit公式GitHub](https://github.com/uezo/aiavatarkit)
- [AivisSpeech公式GitHub](https://github.com/Aivis-Project/AivisSpeech)

# Discord Friend — 共通音声読み上げ

Discord のテキストをボイスチャンネルで読み上げる、Cloudflare Workers / Containers 向けの開発中のサービスです。Node.js の Discord Bot と VOICEVOX を組み合わせ、将来は RSS からも同じ音声合成を利用する構成です。旧 Go 版は `src/bot-go/` に残しています。

## 現状

- Worker が Discord interaction の署名・スコープを検証し、Bot コンテナが Gateway と VC を担当します。VOICEVOX は最初の合成時に起動します。
- ソースには `/join`、`/leave`、`/stop`、`/voice-status`、`/say`、`/model` が実装されています。登録・デプロイ済みのコマンドはソースと一致するとは限りません。
- リポジトリの既定値は Bot 無効、Discord HTTP 受付無効、両コンテナの上限 0 です。デプロイ済み環境の現在の状態は別途確認が必要です。
- 2026-10-03 の限定試験では実際の読み上げを確認しました。その後の実装や RSS 連携の実環境検証を意味しません。詳細と残る検証は [構成・検証ガイド](docs/shared-voice-cloudflare.md) を参照してください。
- 現行の読み上げ構成は音声受信・録音・STT・LLM 応答・画面撮影を開始しません。

## 構成

| パス | 役割 |
| --- | --- |
| `apps/voice/` | Discord Bot、音声再生、VOICEVOX アダプター |
| `deploy/cloudflare/` | Worker、Durable Objects、認可・セッション管理、設定 |
| `docs/` | 構成、操作、開発、検証ガイド |
| `src/bot-go/` | 旧 Go 版の実験コード |

## ローカル検証

CI は Node.js 24.19.0 を使用します。依存関係は各ディレクトリでインストールしてください。

```sh
cd apps/voice
npm ci --ignore-scripts
npm test
npm run check
```

別のシェルまたはリポジトリのルートから:

```sh
cd deploy/cloudflare
npm ci --ignore-scripts
npm run types
npm run check
npm test
```

これらはローカル検証であり、Discord 接続や実音声の確認ではありません。コンテナのオフライン検証は [.github/workflows/shared-voice.yml](.github/workflows/shared-voice.yml) を参照してください。デプロイ、コマンド登録、課金リソースの起動には別途承認と状態確認が必要です。

## ドキュメント

- [はじめに](docs/getting-started.md) · [開発](docs/development.md) · [コマンドと内部 API](docs/api-reference.md) · [トラブルシューティング](docs/troubleshooting.md)
- [Cloudflare 構成・運用上のゲート](docs/shared-voice-cloudflare.md) · [グローバルコマンド登録](docs/global-command-setup.md)
- [AI エージェント向け共通指示](AGENTS.md) · [Claude Code 向け指示](CLAUDE.md)
- [旧 Ollama メモ](OLLAMA_TIPS.md) · [補助スクリプト](scripts/README.md)（旧構成を含む）

機密情報や実 ID をコミットしないでください。問題の報告先は [GitHub Issues](https://github.com/g-kari/discord-friend/issues) です。

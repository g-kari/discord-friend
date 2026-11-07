---
layout: page
title: "開発ガイド"
permalink: /development/
---

# 開発ガイド

`apps/voice/` は Discord Gateway・音声再生と VOICEVOX アダプター、`deploy/cloudflare/` は Worker・Durable Objects と interaction 検証を担当します。設計と運用上の前提は [構成・検証ガイド](https://github.com/g-kari/discord-friend/blob/main/docs/shared-voice-cloudflare.md) を参照してください。

Node.js 24.19.0 を使用し、各ディレクトリで `npm ci --ignore-scripts` を実行します。変更箇所に応じて以下を実行してください。

```sh
# apps/voice/
npm test
npm run check

# deploy/cloudflare/
npm run types
npm run check
npm test
```

詳細な CI とコンテナのオフライン検証は [shared-voice.yml](https://github.com/g-kari/discord-friend/blob/main/.github/workflows/shared-voice.yml) にあります。ローカルテストと実環境試験の結果は区別してください。

署名検証、スコープ分離、期限、停止処理、永続台帳を変更する場合は対応するテストを確認してください。実環境のデプロイ、コマンド登録、課金リソースの起動、台帳の削除やリセットは通常のローカル検証に含まれません。秘密情報をコミットやログに含めず、テストには架空の値を使います。

AI エージェント向けの指示は [AGENTS.md](https://github.com/g-kari/discord-friend/blob/main/AGENTS.md)、Claude Code の補足は [CLAUDE.md](https://github.com/g-kari/discord-friend/blob/main/CLAUDE.md) にあります。`src/bot-go/` は旧実装です。古い Python 用 workflow には現存しない `src/bot/` への参照があり、現行サービスの検証手順として扱わないでください。

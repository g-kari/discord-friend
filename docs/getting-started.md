---
layout: page
title: "はじめに"
permalink: /getting-started/
---

# はじめに

現在の対象は Discord のテキスト読み上げです。Bot と VOICEVOX は Cloudflare Containers、interaction の受付と制御は Worker / Durable Objects で動きます。RSS 利用は後続工程です。

## ローカルで確認する

Node.js 24.19.0（CI と同じ）と npm を用意し、リポジトリをクローンします。

```sh
git clone https://github.com/g-kari/discord-friend.git
cd discord-friend/apps/voice
npm ci --ignore-scripts
npm test
npm run check
```

リポジトリルートから Worker 側も確認します。

```sh
cd deploy/cloudflare
npm ci --ignore-scripts
npm run types
npm run check
npm test
```

テストは実際の Discord 接続や本番リソースの起動を証明しません。CI のコンテナ検証については [workflow](https://github.com/g-kari/discord-friend/blob/main/.github/workflows/shared-voice.yml) を参照してください。

## 実環境について

初期設定は停止状態です。設定ファイルの値と実環境の状態は別々に確認してください。公開、コマンド登録、Container 上限の変更、試験には別途承認が必要です。準備と停止確認は [構成・検証ガイド](https://github.com/g-kari/discord-friend/blob/main/docs/shared-voice-cloudflare.md) に従ってください。トークンや実 ID をログ、Issue、テストデータに含めないでください。

旧 Go 版は `src/bot-go/` にあります。現行サービスの起動手順ではありません。

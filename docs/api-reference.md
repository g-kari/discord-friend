---
layout: page
title: "コマンドと内部 API"
permalink: /api-reference/
---

# コマンドと内部 API

以下は現行ソースの対象です。実環境への登録・反映状況は別途確認してください。操作は設定されたオーナーに限定されます。

| コマンド | 用途 |
| --- | --- |
| `/join` | オーナーの現在の VC に接続し、読み上げセッションを開始 |
| `/leave` | セッションを終了し退出 |
| `/stop` | 再生と待ち行列を停止。接続は維持 |
| `/voice-status` | 状態を確認。停止中の Bot を起動しない |
| `/say` | 指定した本文を読み上げ |
| `/model` | 保存済みの声を一覧・選択。Bot や TTS を起動しない |

通常投稿は許可されたテキストチャンネル内の、同じ VC にいる参加者が対象です。対象範囲、声選択、期限と例外は [構成・検証ガイド](https://github.com/g-kari/discord-friend/blob/main/docs/shared-voice-cloudflare.md) を参照してください。定義は [global-command-setup.ts](https://github.com/g-kari/discord-friend/blob/main/deploy/cloudflare/src/global-command-setup.ts) と関連テストが正です。

Worker は署名検証済み Discord interaction を受け、内部の `http://tts.internal/v1/speech` を Voicevox へルーティングします。TTS アダプターには `/v1/speech` と `/v1/models` があり、公開 API としての利用を想定していません。正確な要求・応答と認可は [実装](https://github.com/g-kari/discord-friend/blob/main/apps/voice/src/http.js) とテストを確認してください。

旧 Go 版のコマンドや STT・LLM・Vision は、このサービスの API ではありません。

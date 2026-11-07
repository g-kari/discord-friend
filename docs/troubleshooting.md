---
layout: page
title: "トラブルシューティング"
permalink: /troubleshooting/
---

# トラブルシューティング

まず実行中のコミット、Worker とコンテナのデプロイ状態、Discord に実際に登録されたコマンドを区別して確認してください。リポジトリの既定値は Bot と HTTP 受付が無効、両コンテナの上限が 0 です。

- **コマンドが表示されない**: 登録対象（guild/global）と Discord の読み戻しを確認します。ソースに定義があるだけでは登録されません。登録手順と不確定時の扱いは [global command setup](https://github.com/g-kari/discord-friend/blob/main/docs/global-command-setup.md) を参照してください。
- **参加できない**: 設定済みオーナーとスコープ、対象チャンネルと VC、Bot の閲覧・接続・発言権限、期限や利用枠を確認します。
- **音声が出ない**: `/voice-status`、Bot と TTS の状態、最初の合成の起動待ち、権限と期限を確認します。VC 接続完了は TTS の準備完了を意味しません。
- **停止や登録の結果が不明**: 自動再試行、台帳削除、操作 ID の使い回しをせず、記録と実リソースの状態を確認します。手順は [構成・検証ガイド](https://github.com/g-kari/discord-friend/blob/main/docs/shared-voice-cloudflare.md) と登録ガイドを参照してください。
- **ローカル検証が失敗**: Node のバージョン、各ディレクトリの依存関係、失敗したテストを確認します。[開発ガイド](../development/) に CI と同じ基本コマンドがあります。

問題を報告する際は、再現手順、時刻、コミット、機密情報を除いたエラーと確認済みの状態を添えてください。トークン、メッセージ本文、音声、実 ID は共有しないでください。停止設定や上限の変更、再デプロイ、実機試験は別途承認が必要です。

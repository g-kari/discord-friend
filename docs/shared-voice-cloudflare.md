# Discord + RSS 共通つむぎ読み上げ（開発中）

既存 `discord-friend` を、Cloudflare Workers / Containers 上のテキスト読み上げBotと共通TTSへ再構成する計画です。
旧Go版の `audio_query → synthesis` という処理を継承しますが、合成失敗をビープ・無音で成功扱いする処理は採用しません。
旧Goコードと履歴は比較用に残し、データ削除や自動移行は行いません。

## 構成

- DiscordBot: 軽量なNode.jsコンテナ。Gateway接続とDAVE対応の音声接続を担当。指定ギルド・テキストチャンネルのみ対象
- Voicevox: CPU版VOICEVOXと小さなHTTPアダプター。つむぎのノーマル音声を名前から解決。通常は停止し、利用時に起動
- Worker: Botからの `http://tts.internal/v1/speech` を内部でVoicevoxへルーティング
- RSS: バックエンドの `VoiceApi` Service Binding経由で同じTTSを利用する予定。ブラウザへの鍵配布や公開TTS APIは不要

`workers.dev`、Preview URL、公開ルートは無効です。RSSにBindingを設定するまではRSSから利用できません。
Botは初期状態 `BOT_ENABLED=false`。設定・承認前はCronからも起動しません。
Botイメージ自体も、明示的な `BOT_ENABLED=true`、30分以内の有効な絶対期限、必要な鍵とIDを確認するまでDiscordクライアントを作成しません。TTSのPID1も、期限を確認するまでエンジンとHTTPアダプターを起動しません。
現在は短時間検証向けで、空の `VOICE_DEADLINE` も起動を拒否します。承認後の検証では30分以内の絶対時刻を一度だけ設定し、再起動でも延長せずWorkerと両コンテナ内で期限切れを止めます。常設運用は別途承認と設定変更が必要です。
有効時は5分ごとの確認とアイドル抑止によりGateway接続を維持します。コンテナ停止・再起動時はVCへの自動復帰をせず、再度 `/join` します。

### 現在の安全停止状態とScheduling Policy

既存の2アプリは `scheduling_policy=default` のまま、設定ファイルでも `max_instances=0` に固定しています。Workerのフラグだけではスケジューラーによる準備・起動を防げないため、現時点ではライブ試験を開始できません。アプリ名・Durable Objectクラス・Binding・既存migrationは変更せず、再デプロイでも停止上限0を保持します。

`durable_object` policyへの移行は、既存Container SDKクラスにフラグを追加するだけでは対応できません。既存アプリのpolicyも変更できません。ネイティブAPIへ移した別クラス、別namespace、別アプリを用意し、旧アプリを停止したまま残す承認済みの移行が必要です。実行時にイメージ・インスタンス種類・通信・期限を指定し、Botの必要メモリも測定します。旧 `basic` と同じ種類はネイティブAPIにないため、無断でスペックや費用を変更しません。

ブランチの自動ビルドは現在有効です。新しいコードの公開前に、旧コミットの完全SHAガードを維持して自動デプロイを止め、レビュー済みの新しいコミットに対する手動試験だけを別途承認します。既存アプリの削除、namespace移行、ライブ試験はこの修正だけでは実行しません。

## 最初の対応範囲

`/join` `/leave` `/stop` `/say` `/voice-status`。操作は設定されたオーナーのみ。
読み上げる通常メッセージは、指定テキストチャンネル内で、現在のVCに参加中の人が送ったもののみ。
Bot投稿、隠されたスポイラー、コード、リンク先本文、添付ファイルを読み上げません。
VC音声の受信・録音・STT・画面撮影・LLM応答は開始しません。旧Go版の `/join` 自動VAD動作は継承しません。

共通APIは `POST /v1/speech`、JSON `{ "text": "こんにちは", "speed": 1 }`。500文字までの合成単位で、48kHz / ステレオ / PCM16のWAVを返します。
長い記事はクライアント側で文の区切りで分割します。RSS側の分割・再生・戻る/次へでの取消は別の統合工程です。
TTSは同時合成1件、上限30秒、出力24MiB。通常のVOICEVOX合成はHTTP取消だけではCPU処理が止まらないため、クライアント取消後も処理完了まで合成枠を保持し、結果は再生せず破棄します。30秒の期限を超えた場合や合成中の通信断で処理完了を確認できない場合はアダプターを終了し、監督プロセスがエンジンも強制停止します。検証の絶対期限は独立した監視プロセスでも確認するため、APIのイベントループが停止しても強制停止します。混雑時は429となり、無制限待ち行列や自動再送はしません。
Botの待ち行列は再生中を含め10件。500文字を超える通常投稿は無断で切らず読み上げを省略し、状態に表示します。
音声・本文の永続保存、本文ログ、永続キャッシュは現在ありません。

## 起動前の承認と検証

1. Workers有料プランはユーザーが契約済みと申告。Containersの従量費用は追加となるため、上限・運用時間を合意してから有効化
2. Discordアプリ、Bot token設定、ギルドへの招待とMessage Content Intent等は別途承認。秘密情報はチャットやGitに貼らず、正式な秘密情報入力経路で設定
3. ギルド、読み上げテキストチャンネル、オーナーIDを確認。既存の進捗通知Webhookを音声Botの鍵として流用しない
4. VOICEVOX・春日部つむぎの最新規約を確認し、Bot説明・設定画面に `VOICEVOX:春日部つむぎ` を表示
5. Cloudflare上でGateway接続、UDP discovery、DAVE ready、短い実音声、停止、無人退出、再起動復旧を検証

Containersへの外部UDP受信はHTTP ingressと別の制約です。Discord Botが開始するUDP通信の実動作はまだ検証していません。
型チェックや合成モックの成功をDiscord通話成功と同一視しないこと。
VOICEVOXコンテナのcold start、メモリ使用量、実際の合成速度も要測定です。現在のinstance_typeは検証用候補で、最低必要スペックの実測値ではありません。

## 費用の考え方

Botの常時稼働はメモリ・ディスクの稼働時間分を消費します。VOICEVOXは未使用2分で停止しますが、読み上げの頻度によって稼働時間が延びます。
無料保証はありません。現在の上限は各0台です。承認された試験で将来各1台に制限しても月額の厳密な停止上限にはなりません。
既存有料プランの同梱枠が他用途で使われている可能性を含めて見積もります。追加予算未承認のままデプロイしません。

## 検証の区分

- Nodeのユニットテスト: HTTP制限、合成失敗、取消後の合成枠保持、混雑、WAV検査、待ち行列、接続取消・競合を合成データで検証。監督プロセスの期限切れ・合成タイムアウトはSIGTERMを無視するCPU処理中の実サブプロセスで停止を検証。再起動後も元の絶対期限を保持することを確認
- Worker: Wranglerから型生成しTypeScript検査
- Docker build / 実VOICEVOX / Cloudflare上の通信 / 実Discord再生: 別々のゲート。CIの実VOICEVOX期限検証は起動成功、期限直前の合成継続、早すぎない停止、期限後8秒以内の停止を要求する。未実施のものを完了と扱わない
- スタイル変更・辞書・Webダッシュボード・RSS統合: 後続工程

## 一次資料（2026-10-02 JST確認）

- https://voiscord.net/
- https://docs.discord.com/developers/topics/voice-connections
- https://github.com/discordjs/discord.js/tree/main/packages/voice
- https://github.com/bwmarrin/discordgo/issues/1697
- https://github.com/VOICEVOX/voicevox_engine/releases/tag/0.25.2
- https://voicevox.hiroshiba.jp/product/kasukabe_tsumugi/
- https://tsumugi-official.studio.site/rule
- https://developers.cloudflare.com/containers/api/container-class/
- https://developers.cloudflare.com/containers/configuration/outbound-traffic/
- https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/
- https://developers.cloudflare.com/containers/platform/pricing/

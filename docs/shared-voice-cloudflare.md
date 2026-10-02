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

## 停止中のサーバー限定コマンド登録

登録用Cron経路はBotコンテナを起動しません。既存 `DiscordBot` Durable Objectの専用RPCが、Workerに設定済みのSecret Bindingを内部で使います。鍵の取り出し、シェルへのコピー、新しい公開URLや認証キーの発行は不要です。SDKの `fetch` / `start` やGatewayログインは登録経路から呼びません。実コンテナが稼働中の場合も登録を拒否します。

登録対象は承認済みApplication・Guild・Text Channel・Ownerの組み合わせに固定しています。実IDはWorkerの設定だけに置き、リポジトリにはコロン区切りの4つのIDのSHA-256 fingerprintだけを保存します。別の組み合わせは書き込み前に拒否し、対象の変更にはコードの再レビューが必要です。`GET /applications/@me` で設定済みBot tokenのApplication IDを確認し、チャンネルの所属Guildと種類を確認してから、Guildの既存コマンドを取得します。テストには実IDを使いません。

既存の同名スラッシュコマンドが定義まで一致する場合は書き込みを省略します。取得時は `with_localizations=true` で別言語の定義も確認します。同名で説明・引数・既定権限等が違う場合は、最初の書き込み前に登録全体を停止します。追加は `/join`、`/leave`、`/stop`、`/voice-status`、`/say` の不足分だけを個別POSTします。他のコマンドや同名のコンテキストメニューは残し、Bulk Overwrite・削除・権限上書きは行いません。登録後に5コマンドすべてを再取得して確認します。

Discordの個別POSTは同名コマンドのupsertで、条件付きcreate-if-absentではありません。各POST直前にも再取得して衝突を止めますが、取得からPOSTまでに別の登録処理が同名コマンドを作る競合を完全には防げません。POSTが既存上書きを示すHTTP 200を返した場合は、不確定状態として残りの書き込みを停止します。この時点でDiscord側はすでに1コマンドを上書きしており、元に戻ったという保証はしません。実行中はDeveloper Portal、旧登録スクリプト、他のBot登録処理でこの5つの名前を書き換えないことが前提です。排他的な登録操作を確認できない場合は実行を見送ります。

初期設定では登録を無効にしています。レビュー済みコードの停止状態での反映と、指定Guildへの登録実行が承認された後に限り、次を一度だけ設定します。

- `BOT_ENABLED=false`、`VOICE_DEADLINE=""`、両アプリの `max_instances=0` を維持
- 既存のGuild・Text Channel・Ownerと確認済みApplication IDを設定
- `CONFIRM_DISCORD_SETUP=register-guild-commands-v1`
- `DISCORD_SETUP_OPERATION_ID` に新しいUUID v4
- `DISCORD_SETUP_DEADLINE` に10分以内の未来の絶対UTC時刻。再起動で延長しない

次の5分Cronが登録を試みます。1リクエストは5秒、全操作は25秒、JSON応答は64KiB以内に制限し、リダイレクトを拒否します。外部API呼び出し前に `voice_setup_receipts` テーブルへ操作のclaimを永続化します。同じ操作IDは再実行せず、書き込み後の応答が不明な状態は `uncertain` として、新しい操作IDでも自動再試行を拒否します。中断した `pending` も同様です。不確定状態の復旧は、Discordの登録状態を安全に読み戻してから別途明示的に判断します。

Secret、API応答全体、チャンネル本文、アプリ所有者情報を保存・ログ出力しません。保存するのは操作ID、対象Application/Guild、日時、検証済みコマンド名、最後に試みた名前、固定エラーコードだけです。

登録結果はサンプリングされたログの有無で決めません。Cloudflareの認証済みDurable Object SQL APIで、既存BOT namespaceの名前 `discord-singleton` に対して `SELECT operation_id, receipt FROM voice_setup_receipts` を読みます。成功は `state=complete` と5つの `verifiedNames` を確認します。完了確認後は3つの登録用フラグ・操作ID・期限を空へ戻します。これらの手順は実際の反映・登録を承認するまで実行しません。

### Containerの関連付けと接続確認

2026-10-02にIDを設定したAPI由来Worker versionは、直前のWrangler versionと同じscript ETagを持ちますが、`script_runtime.containers` のメタデータを返していません。2アプリの画像・namespaceと上限0は残っています。これは関連付けが実行時に利用できることの証明にはならず、Container SDKは `ctx.container` が無いとconstructorで失敗します。後の登録・ライブ試験前に、レビュー済みコードを完全SHAガード付きの停止設定でWranglerから反映し、対象classとアプリ名の関連付け、同じnamespace、両アプリの上限0・稼働0を読み戻す必要があります。IDのsettings更新だけを反映手順の代わりにしません。

接続確認RPCは、`BOT_ENABLED=true`、30分以内の有効な `VOICE_DEADLINE`、必要なIDとSecretがそろったときだけBot `/health` を呼びます。この経路はコンテナ起動を伴うため、別途承認された予算・試験時間・起動上限の範囲だけで実行します。停止設定では `/health` を呼びません。結果は `voice_readiness_snapshot` テーブルへ最後の1件だけ保存し、SQL APIで `SELECT snapshot FROM voice_readiness_snapshot WHERE id = 1` を読みます。

`gateway-ready` はHTTP 200と `client.isReady()` の両方が成功した意味です。ポート応答、スケジューラーのhealthy、ログの欠落をDiscord接続成功として扱いません。この確認も音声UDP/DAVE接続や実再生の証明にはなりません。`/join` はオーナーが明示的に実行したとき、そのオーナーの現在の通常VCだけに接続します。

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
- Worker setup: 実SQLiteの操作claim・再起動・並行呼び出し・不確定書き込みの再試行拒否、モックDiscordのApplication/Channel一致・コマンド衝突・期限切れ・読み戻し・応答上限。実SecretやDiscordへ通信せず検証
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
- https://docs.discord.com/developers/resources/application#get-current-application
- https://docs.discord.com/developers/interactions/application-commands#create-guild-application-command
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

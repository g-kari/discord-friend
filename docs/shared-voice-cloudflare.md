# Discord + RSS 共通つむぎ読み上げ（開発中）

既存 `discord-friend` を、Cloudflare Workers / Containers 上のテキスト読み上げBotと共通TTSへ再構成する計画です。
旧Go版の `audio_query → synthesis` という処理を継承しますが、合成失敗をビープ・無音で成功扱いする処理は採用しません。
旧Goコードと履歴は比較用に残し、データ削除や自動移行は行いません。

## 構成

- DiscordBot: 軽量なNode.jsコンテナ。Gateway接続とDAVE対応の音声接続を担当。指定ギルド・テキストチャンネルのみ対象
- Voicevox: CPU版VOICEVOXと小さなHTTPアダプター。つむぎのノーマル音声を名前から解決。通常は停止し、利用時に起動
- Worker: 署名検証済みDiscord HTTP interactionsを受付。Botからの `http://tts.internal/v1/speech` を内部でVoicevoxへルーティング
- RSS: バックエンドの `VoiceApi` Service Binding経由で同じTTSを利用する予定。ブラウザへの鍵配布や公開TTS APIは不要

現在反映済みの本番は `workers.dev`、Preview URL、公開ルートが無効で、両コンテナの上限・稼働数は0です。指定サーバー限定の `/join`、`/leave`、`/stop`、`/voice-status`、`/say` の登録・Discordからの読み戻しは完了しました。以下のHTTP受付・コマンド起動の変更は別ブランチのレビュー対象で、まだ本番へ反映しません。RSSにBindingを設定するまではRSSから利用できません。

Botは初期状態 `BOT_ENABLED=false`、HTTP受付も `DISCORD_HTTP_ENABLED=false`。公開鍵は空で、公開URLも有効にしません。Cronはジョブ掃除と既存コンテナの観察だけを行い、停止中のコンテナを起動しません。
Botイメージ自体も、明示的な `BOT_ENABLED=true`、HTTPコマンド経路、UUIDのセッションID、30分以内の有効な絶対期限、承認済み固定スコープのfingerprint、必要な鍵とIDを確認するまでDiscordクライアントを作成しません。TTSのPID1も、期限を確認するまでエンジンとHTTPアダプターを起動しません。SDKの既定起動環境は停止設定と空の期限で、検証済みのセッションだけが起動時の環境を渡します。
現在は短時間検証向けで、空の `VOICE_DEADLINE` も起動を拒否します。承認後の検証では30分以内の絶対時刻を一度だけ設定し、再起動でも延長せずWorkerと両コンテナ内で期限切れを止めます。常設運用は別途承認と設定変更が必要です。
`/join` でBotを起動し、Gatewayが準備できた後でオーナーの現在の通常VCを確認します。VCのView Channel・Connect・Speak権限を確認し、明示コマンドによってだけ接続します。VOICEVOXは最初の合成時に起動します。停止中の `/leave`、`/stop`、`/voice-status`、`/say` はBot/TTSを起こしません。再起動後のVC自動復帰も行いません。

無操作は既定5分です。受け付けた `/join`・`/say`・`/stop`、読み上げ対象の投稿、次の待ち音声の処理が活動となり、`/voice-status`、監視用のhealth取得やVoice Stateイベントは期限を延ばしません。`/leave`、無人退出、Botの切断、起動失敗、アイドル・絶対期限では両コンテナを停止します。`/stop` は接続中の音声と待ち行列を止め、接続自体はアイドル期限まで保持します。再度の `/join` は新しいプロセス世代を持ち、稼働中の元の絶対期限を延長しません。Cold start中の再joinは重ねて起動せず、先に終了または退出を待ちます。

### 現在の安全停止状態とScheduling Policy

既存の2アプリは `scheduling_policy=default` のまま、設定ファイルでも `max_instances=0` に固定しています。default policyのDO-backedアプリはSDKによるリクエスト時の起動・sleep・stopに対応しており、コマンド起動のためにpolicy移行は必須ではありません。固定のアプリ名・Durable Objectクラス・Binding・namespace・既存 `voice-v1` migrationとinstance_typeを維持します。現時点の上限0ではライブ試験を開始しません。

後の承認済み試験では、desired instancesが0であることを読み戻した上で各上限を1に変更します。Wrangler 4.146.0はdefaultのDO-backed新規アプリに `instances:0` と明示した上限を送ります。上限1は常時1台を要求する値ではありません。実際の起動と停止・費用はCloudflareで測定する必要があります。

`durable_object` policyは実行時のイメージ・種類の選択や独立rollout向けの別の選択肢です。既存policyは変更できず、移行するなら別アプリ・別クラス・別namespaceが必要です。SDKもそのpolicyを支援せず、Botの `basic` は対応するネイティブ種類にありません。この変更ではpolicy移行、既存データの移動や削除、スペック変更を行いません。defaultを維持したままdirect DO APIへコードを移すことも可能ですが、今回はSDKを残します。

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
音声の保存、長期の本文保存、本文ログ、永続キャッシュは行いません。HTTP応答と短い起動待ちに必要な一時的な暗号化payloadは、後述の期限と掃除で扱います。

## コマンド起動のHTTP受付（未反映）

公開予定の経路は `POST /interactions` だけです。毎回、Ed25519署名をawaitし、timestampのUTF-8バイト列と受信した本文そのものを検証してからJSONを解釈します。本文は16KiB・読取1秒、timestampは過去60秒・未来10秒以内というアプリ独自のfreshness policyです。署名がない・壊れている・古い場合は401となり、Containerへ触れません。署名済みPINGは起動せず `type:1` を返します。

コマンドは固定Application・Guild・Text Channel・Ownerと5つの名前に限定します。DM・他オーナー・他のチャンネル・未知の引数は実行しません。正しい操作には3秒以内を目指し、起動を待たずHTTP本文でephemeralな `type:5` を返します。DOへの処理は `waitUntil` の背景処理へ渡し、後でDiscordの元応答をPATCHします。元応答の編集が失敗しても音声操作は再送しません。別URLへのredirect、Webhook URL・Token・本文・例外全体のログ出力も行いません。

DiscordのInteractions Endpoint URLを設定すると、アプリ全体のinteraction配送がHTTPへ切り替わります。BotにはGatewayのInteractionCreate listenerを置かず、5コマンドの受付・初期応答・結果応答はHTTP側が担当します。GatewayはVoice State・通常投稿・音声接続のためだけに残します。アプリに他のコマンドや他Guildの利用者がいないかは、公開設定前の確認事項です。未知・対象外の操作は実行せず、HTTP側の固定応答となります。

DOの `voice_interaction_jobs` はinteraction IDを同期的にclaimし、同じIDを並行に受け取っても1回だけ実行します。本文hashが違う同じIDも再実行しません。実行済み・途中で応答不明となった操作を自動再開しません。Nodeの非公開APIもinteraction IDとプロセス世代を検証し、遅れて届いたjoin/sayが新しいleave/stopを越えて実行されることを防ぎます。通常操作は毎分10件・待機8件・metadata256件で制限し、leave/stopは容量を使い切っていても優先します。sessionがまだ無い初回のleave/stopも、独立した永続control IDで古いjoinを拒否します。control IDは本文やTokenを持たず、DO再構築やmetadataの期限掃除後も取消の順序を保持します。

起動をまたぐ結果応答に必要なTokenとsay本文だけを、既存Worker Secretから内部で導いたAES-GCM keyとランダムnonceで暗号化します。新しいcredentialやkey設定は作りません。鍵を保存・出力せず、command IDをAADとして別IDへの転用を拒否します。TokenはNodeやSDKのschedule payloadへ渡しません。復号を許す期間は90秒以内で、実行claim時に保存したciphertextを削除し、その後は背景処理のメモリにだけ保持します。

静かなまま・起動しないままでも、独立したSDK sweep scheduleと5分Cronが掃除します。SDKのcallbacksは順番に実行されるため、混雑・障害時の物理的な削除が90秒ぴったりに完了する保証はしません。90秒以後の復号・実行は拒否し、期限切れciphertextを掃除します。IDによるdedup metadataは15分の期限で削除します。SQLへの永続claimに失敗した場合は外部操作を行いません。job schedule作成に失敗した場合もpayloadを削除して新規起動を止めます。

Botのimage leaseは、前世代のstop eventを同期した後、外部起動の前に保存・syncします。古い世代のhealth確認が失敗しても新しいimageを破壊しません。TTSのleaseと終了したセッションのrevocationも保存し、退出後に遅れて到着した合成要求やDO再構築でTTSが再び起動することを拒否します。SDK固有のalarmを置き換えず、SDK `schedule()` で期限・掃除・終了確認を予約します。

### 反映前に必要な承認・実測

このPRはコード・offline検証までです。公開鍵の設定、公開Worker URL、Discord Developer PortalのInteractions Endpoint URL、Bot有効化、上限1、試験の絶対期限と予算をまとめて確認してから反映します。まず署名済みPINGと停止状態を確認し、その後の明示 `/join` だけで起動します。起動待ちは最大70秒の背景処理に制限し、失敗時は当該世代を停止します。実測したcold start・Gateway準備・通常VC参加・UDP/DAVE・音声再生・leave・無操作終了・上限/稼働0の読み戻しが完了するまで、実音声が動いたとは扱いません。

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

Workersでは `redirect: 'manual'` を指定し、3xxは本文を読まず取消して `DISCORD_REDIRECT_REFUSED` で停止します。`Location` のURLへ移動せず、Bot credentialも転送しません。`redirect: 'error'` はworkerdで未対応で、Discordへの最初の通信前に例外となるため使用しません。タイムアウト・取消は `DISCORD_REQUEST_ABORTED`、fetchのTypeErrorは `DISCORD_FETCH_REJECTED`、その他の例外は `DISCORD_REQUEST_FAILED` として記録し、例外メッセージ・URL・ヘッダー・スタックは保存しません。これらのコードだけで鍵が正しいかを判定しません。

Secret、API応答全体、チャンネル本文、アプリ所有者情報を保存・ログ出力しません。保存するのは操作ID、対象Application/Guild、日時、検証済みコマンド名、最後に試みた名前、固定エラーコードだけです。

登録結果はサンプリングされたログの有無で決めません。Cloudflareの認証済みDurable Object SQL APIで、既存BOT namespaceの名前 `discord-singleton` に対して `SELECT operation_id, receipt FROM voice_setup_receipts` を読みます。成功は `state=complete` と5つの `verifiedNames` を確認します。完了確認後は3つの登録用フラグ・操作ID・期限を空へ戻します。これらの手順は実際の反映・登録を承認するまで実行しません。

### Containerの関連付けと接続確認

2026-10-02のsettings APIによるID更新では、同じscript ETagでも `script_runtime.containers` のメタデータが欠けたversionが作られました。その後、停止設定の完全Wrangler反映で関連付けを復旧し、現行版で両class/app・元のnamespace・上限0と稼働0を確認済みです。SDKは `ctx.container` が無いとconstructorで失敗するため、後の反映でも完全SHAガード付きWrangler uploadと関連付けの読み戻しを行います。settings更新だけを反映手順の代わりにしません。

関連付けの復旧を確認した後の登録設定・解除も、WranglerのWorker upload経由で行います。`--containers-rollout=none` は現在のversionからContainerメタデータを継承し、Docker build・image push・アプリのrolloutを省略します。関連付けが欠けたversionに対して、このフラグだけで復旧したことにはしません。設定ファイルにある空のIDは `--keep-vars` 使用時も同名の既存値を上書きするため、承認済みの4つの非Secret IDを `--var` で明示します。登録の有効化・解除では同じIDと停止フラグを維持し、SecretをCLI引数へ渡しません。最終versionの関連付け・ID一致・登録フラグ解除・稼働0を読み戻します。

今回のBotイメージ変更を初めて反映するときは、停止上限0のまま通常のWrangler deployでDocker build・registry push・既存アプリのimage更新も行う必要があります。`--containers-rollout=none` の設定変更だけでは、以前のGateway版イメージは置き換わりません。新しい停止版とimage digestを確認した後のフラグ変更・終了処理で、この省略フラグを使います。

接続確認RPCは、`BOT_ENABLED=true`、30分以内の有効な `VOICE_DEADLINE`、必要なIDとSecretがそろい、コンテナが既にrunningの場合だけBot `/health` を直接観察します。停止中は起動せず503の観察結果となり、停止設定では `/health` を呼びません。結果は `voice_readiness_snapshot` テーブルへ最後の1件だけ保存し、SQL APIで `SELECT snapshot FROM voice_readiness_snapshot WHERE id = 1` を読みます。起動経路は署名検証済みの明示 `/join` です。

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
- Worker: Wranglerから型生成しTypeScript検査。HTTP署名・freshness・scope・即時応答、SQLite claim・暗号化・失敗/重複・stop優先とcold start取消を検証
- Worker setup: 実SQLiteの操作claim・再起動・並行呼び出し・不確定書き込みの再試行拒否、モックDiscordのApplication/Channel一致・コマンド衝突・期限切れ・読み戻し・応答上限。実SecretやDiscordへ通信せず検証
- Worker fetch: 本番と同じcompatibility date / nodejs_compatの実workerdで、実際の登録ヘルパーをbundleして検証。外部通信をすべて合成サービスへ置き換え、5コマンド登録・読み戻しと各種3xxの停止を確認。Nodeだけのfetch mockではWorkers固有のredirect仕様を検証したことにしない
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
- https://docs.discord.com/developers/interactions/overview#validating-security-request-headers
- https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback
- https://developers.cloudflare.com/containers/configuration/scheduling-policy/
- https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-container-api/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

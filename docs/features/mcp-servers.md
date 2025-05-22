---
layout: default
title: MCPサーバー自動接続機能
parent: 機能ガイド
nav_order: 1
description: "Discord AI Voice Bot - MCPサーバー自動接続機能"
permalink: /features/mcp-servers/
---

# MCPサーバー自動接続機能
{: .fs-9 }

自動接続機能のセットアップと使用方法
{: .fs-6 .fw-300 }

このドキュメントでは、MCP（マルチチャンネルプレゼンス）サーバー自動接続機能のセットアップとテスト方法について説明します。

## 概要

MCP自動接続機能を使用すると、ボットが起動時に指定したDiscordサーバーのボイスチャンネルに自動的に接続します。この機能は、運用環境でボットを常に特定のチャンネルでアクティブにしておきたい場合に特に役立ちます。

## 環境設定

1. `.env` ファイルに以下のような設定を追加します：
   ```
   DISCORD_BOT_TOKEN=your_bot_token
   DIFY_API_KEY=your_dify_api_key
   OPENAI_API_KEY=your_openai_api_key
   MCP_SERVERS={"Server Name": ["Voice Channel 1", "Voice Channel 2"]}
   ```

   注意：「Server Name」を実際のDiscordサーバー名に、「Voice Channel 1」「Voice Channel 2」を自動的に参加させたいボイスチャンネル名に置き換えてください。

## 設定方法

### 環境変数での設定

`MCP_SERVERS` 環境変数は、JSON形式で指定します：

```json
{
  "サーバー名1": ["チャンネル名1", "チャンネル名2"],
  "サーバー名2": ["チャンネル名3"]
}
```

### コマンドを使用した設定

以下のスラッシュコマンドを使用して、実行時に設定を更新できます：

1. `/add_mcp_server` - 現在接続しているボイスチャンネルを自動接続リストに追加
   - `add_to_config:true` - 設定を.envファイルに永続的に保存

2. `/list_mcp_servers` - 現在設定されている自動接続サーバーとチャンネルの一覧を表示

3. `/remove_mcp_server` - 自動接続リストからチャンネルを削除
   - `server_name:"サーバー名" channel_name:"チャンネル名"` - 特定のサーバーとチャンネルを指定して削除
   - `remove_from_config:true` - 設定を.envファイルからも削除

## テストケース

### 1. 基本的な自動接続

**手順:**
1. 上記のように `MCP_SERVERS` 環境変数を設定
2. ボットを起動
3. ログでauto-joinメッセージを確認

**期待される結果:**
- ボットは「MCPサーバーへの自動接続を開始します」とログに記録
- ボットは指定されたチャンネルへの接続を試みる
- 接続に成功した場合、ボットは「ボイスチャンネル「チャンネル名」に自動接続しました」とログに記録

### 2. 無効なチャンネル名

**手順:**
1. 存在しないチャンネル名で `MCP_SERVERS` を設定
2. ボットを起動

**期待される結果:**
- ボットはチャンネルが見つからないという警告メッセージをログに記録
- エラーにもかかわらず、ボットは通常通り動作を継続

### 3. コマンドテスト

#### /add_mcp_server コマンド

**手順:**
1. ボイスチャンネルに参加
2. `/add_mcp_server` コマンドを実行
3. `/add_mcp_server add_to_config:true` コマンドを実行

**期待される結果:**
- 最初のコマンドはチャンネルをメモリ内リストに追加
- 2番目のコマンドはチャンネルを.envファイルに追加
- ボットはアクションを確認するメッセージで応答

#### /list_mcp_servers コマンド

**手順:**
1. いくつかのMCPサーバーを設定
2. `/list_mcp_servers` コマンドを実行

**期待される結果:**
- ボットは自動接続リスト内のサーバーとチャンネルのリストで応答

#### /remove_mcp_server コマンド

**手順:**
1. いくつかのMCPサーバーを設定
2. `/remove_mcp_server` コマンドを実行（現在のサーバーとチャンネルを使用）
3. `/remove_mcp_server server_name:"サーバー名" channel_name:"チャンネル名"` コマンドを実行
4. `/remove_mcp_server remove_from_config:true` コマンドを実行

**期待される結果:**
- 最初のコマンドは現在のチャンネルをメモリ内リストから削除
- 2番目のコマンドは指定されたサーバーから指定されたチャンネルを削除
- 3番目のコマンドはチャンネルを削除し.envファイルを更新
- ボットは各アクションを確認するメッセージで応答

## トラブルシューティング

自動接続機能が期待通りに動作しない場合：

1. ボットのログでエラーメッセージを確認
2. `MCP_SERVERS` 環境変数のJSON形式が正しいことを確認
3. ボットが指定されたボイスチャンネルに参加する権限を持っていることを確認
4. サーバー名とチャンネル名が完全に一致していること（大文字小文字も区別）を確認

## コード実装

自動接続機能の実装は、主に以下のファイルで行われています：

- `config.py` - MCP_SERVERS環境変数の読み込み処理
- `discord_aiavatar_complete.py` - 起動時の自動接続ロジック

環境変数の読み込みは次のように実装されています：

```python
# MCP_SERVERSの読み込み
MCP_SERVERS = {}
mcp_servers_env = os.getenv("MCP_SERVERS")
if mcp_servers_env:
    try:
        MCP_SERVERS = json.loads(mcp_servers_env)
    except json.JSONDecodeError:
        logger.error("警告: MCP_SERVERSの形式が正しくありません。JSONフォーマットで指定してください。")
```
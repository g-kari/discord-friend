---
layout: default
title: 機能ガイド
nav_order: 3
description: "Discord AI Voice Bot - 機能ガイド"
has_children: true
permalink: /features/
---

# 機能ガイド
{: .fs-9 }

Discord AI Voice Botの機能詳細
{: .fs-6 .fw-300 }

このセクションでは、Discord AI Voice Botの各機能の詳細な使い方とセットアップ方法を説明します。

## 主な機能

Discord AI Voice Botには、以下のような主要機能があります：

### ボイスチャネル機能

- **ボイスチャンネル常駐型**: ボットはボイスチャンネルに参加し続け、継続的な会話を可能にします
- **話し始めたユーザーを検知して自動録音**: ユーザーが話し始めると自動的に録音を開始し、無音が検出されると録音を停止します
- **MCPサーバー自動接続機能**: 起動時に指定されたサーバーとボイスチャンネルに自動的に接続します

### AI会話機能

- **カスタムプロンプト**: ユーザーごとにAIの応答スタイルや性格を設定できます
- **キーワード検出**: 特定のキーワードを含む発言にのみ応答するように設定できます
- **会話履歴の永続化**: SQLiteを使用して会話履歴を保存し、より自然な会話を実現します

## 機能ガイド

詳細な機能ごとのガイドについては、以下のリンクを参照してください：

- [MCPサーバー自動接続機能](./mcp-servers/) - ボットを特定のボイスチャンネルに自動的に参加させる方法

## コマンド一覧

### テキストコマンド

以下のコマンドはチャットチャンネルで `!` プレフィックスを使用して実行できます：

- `!join` - ボイスチャンネルに参加
- `!leave` - ボイスチャンネルから退出
- `!set_prompt <プロンプト>` - AIのシステムプロンプトを設定
- `!recording_on [キーワード]` - 録音をオンにし、オプションでキーワードを設定
- `!recording_off` - 録音をオフにする（Botが反応しなくなる）
- `!history_clear` - 会話履歴をクリア

### スラッシュコマンド

以下のコマンドはDiscordのスラッシュコマンド機能を使用して実行できます：

- `/join` - ボイスチャンネルに参加
- `/leave` - ボイスチャンネルから退出
- `/set_prompt <プロンプト>` - AIのシステムプロンプトを設定
- `/set_default_prompt <プロンプト>` - AIのデフォルトシステムプロンプトを設定（管理者のみ）
  - `add_to_config:true` - 設定を.envファイルに永続的に保存
- `/recording_on [キーワード]` - 録音をオンにする
- `/recording_off` - 録音をオフにする
- `/history_clear` - 会話履歴をクリア
- `/talk` - 会話を開始する
- `/add_mcp_server` - 現在のボイスチャンネルをMCPサーバーリストに追加
  - `add_to_config:true` - 設定を.envファイルに保存
- `/list_mcp_servers` - 設定されているMCPサーバーとチャンネルの一覧を表示
- `/remove_mcp_server` - MCPサーバーリストからチャンネルを削除
  - `server_name:"Server Name" channel_name:"Channel Name"` - 特定のサーバーとチャンネルを指定して削除
  - `remove_from_config:true` - 設定を.envファイルから削除
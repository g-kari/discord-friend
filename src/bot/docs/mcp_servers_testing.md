# MCP Server Auto-Join Feature - Testing Guide

This document provides instructions for testing the MCP server auto-join functionality.

## Environment Setup

1. Create a `.env` file with the following configuration:
   ```
   DISCORD_BOT_TOKEN=your_bot_token
   DIFY_API_KEY=your_dify_api_key
   OPENAI_API_KEY=your_openai_api_key
   MCP_SERVERS={"Server Name": ["Voice Channel 1", "Voice Channel 2"]}
   ```

   Note: Replace "Server Name" with the actual name of your Discord server, and "Voice Channel 1", "Voice Channel 2" with the names of the voice channels you want the bot to join automatically.

## Test Cases

### 1. Basic Auto-Join

**Steps:**
1. Configure the MCP_SERVERS environment variable as shown above
2. Start the bot
3. Check the logs for auto-join messages

**Expected Result:**
- Bot should log "MCPサーバーへの自動接続を開始します"
- Bot should attempt to join the specified channels
- For successful connections, bot should log "ボイスチャンネル「Channel Name」に自動接続しました"

### 2. Invalid Channel Names

**Steps:**
1. Configure MCP_SERVERS with non-existent channel names
2. Start the bot

**Expected Result:**
- Bot should log warning messages about channels not found
- Bot should continue operating normally despite the errors

### 3. Command Tests

#### /add_mcp_server Command

**Steps:**
1. Join a voice channel
2. Execute `/add_mcp_server` command
3. Execute `/add_mcp_server add_to_config:true` command

**Expected Result:**
- First command should add the channel to the in-memory list
- Second command should add the channel to the .env file
- Bot should confirm the action with a message

#### /list_mcp_servers Command

**Steps:**
1. Configure some MCP servers
2. Execute `/list_mcp_servers` command

**Expected Result:**
- Bot should respond with a list of servers and channels in the auto-join list

#### /remove_mcp_server Command

**Steps:**
1. Configure some MCP servers
2. Execute `/remove_mcp_server` command (uses current server and channel)
3. Execute `/remove_mcp_server server_name:"Server Name" channel_name:"Channel Name"` command
4. Execute `/remove_mcp_server remove_from_config:true` command

**Expected Result:**
- First command should remove the current channel from the in-memory list
- Second command should remove the specified channel from the specified server
- Third command should remove the channel and update the .env file
- Bot should confirm each action with a message

## Troubleshooting

If the auto-join feature is not working as expected:

1. Check the bot logs for any error messages
2. Verify that the JSON format in the MCP_SERVERS environment variable is correct
3. Make sure the bot has permissions to join the specified voice channels
4. Confirm that the server and channel names match exactly (case-sensitive)
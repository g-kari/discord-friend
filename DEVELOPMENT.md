# Discord AI Avatar Bot - Development Guide

This document provides technical information for developers. For general information and usage, see the main README.md.

## Project Structure

```
src/bot/
├── discord_aiavatar_complete.py  # Main bot file
├── config.py                     # Configuration and environment variables
├── models/                       # Data models
│   └── database.py               # Database interactions
├── services/                     # Service integrations
└── requirements.txt              # Python dependencies
```

## Key Components

### Discord Bot

The main Discord bot is implemented in `discord_aiavatar_complete.py`. It uses discord.py to interface with the Discord API.

Key functions:
- Voice recognition and processing
- Integration with AI services
- User preference management
- Voice channel interactions

### Configuration

Configuration is managed via `config.py` and environment variables loaded from a `.env` file.

Required environment variables:
- `DISCORD_BOT_TOKEN`: Your Discord bot token
- `DIFY_API_KEY`: API key for Dify AI
- `DIFY_API_URL`: URL for Dify API
- `OPENAI_API_KEY`: OpenAI API key for speech recognition
- `AIVISSPEECH_API_URL`: URL for AivisSpeech API (defaults to http://localhost:50021)

Optional environment variables:
- `MCP_SERVERS`: JSON-formatted configuration for servers and voice channels to auto-join on startup.
  Example: `{"Server Name": ["Voice Channel 1", "Voice Channel 2"]}`

### Database

The bot uses SQLite for data storage. The database file is `aiavatar_bot.db` by default.

Main tables:
- `recording_settings`: User preferences for voice recording
- `user_settings`: General user settings and preferences

## Development Workflow

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development setup and workflow information.

## Architecture

The bot follows these main execution flows:

1. **Voice Recognition**:
   - User speaks in a voice channel
   - Audio is captured and processed
   - Speech is converted to text using OpenAI
   - Text is sent to AI service for processing

2. **AI Response**:
   - Response from AI service is processed
   - Text is converted to speech using AivisSpeech
   - Audio is played back in the voice channel

3. **Command Handling**:
   - Users can control the bot with Discord slash commands
   - Commands manage settings, trigger actions, or query information

4. **Auto-Join Feature**:
   - Bot can automatically join specified voice channels on startup
   - Configured via the `MCP_SERVERS` environment variable
   - Useful for production deployments where the bot should be active in specific channels
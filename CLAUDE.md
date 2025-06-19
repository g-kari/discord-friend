# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🚀 Quick Start

```bash
# 1. Setup Go bot
cd src/bot-go
cp .env.example .env
# Edit .env with your DISCORD_BOT_TOKEN

# 2. Start development mode (auto-restart with Air)
./start_watch.sh

# 3. Build and run
go build -o discord-bot cmd/bot/main.go
./discord-bot
```

## Project Overview

This is a Japanese AI voice bot for Discord implemented in Go:

### Go Implementation
- **discordgo**: Discord API library for Go
- **layeh.com/gopus**: Real Opus audio codec support for Discord
- **Air**: Live reload for Go development
- **Screen sharing recognition**: Screenshot analysis and real-time monitoring
- **Vision AI**: OpenAI Vision API and Ollama LLaVA integration
- **Voice Activity Detection (VAD)**: Automatic voice recording system
- Clean architecture with separation of concerns
- Located in `src/bot-go/`

## Development Commands

```bash
cd src/bot-go

# Install dependencies
go mod download

# Run with hot reload (Air)
./start_watch.sh

# Run directly
go run cmd/bot/main.go

# Build
go build -o discord-bot cmd/bot/main.go

# Test
go test ./...

# Format code
go fmt ./...

# Lint (install golangci-lint first)
golangci-lint run
```

## Architecture

```
src/bot-go/
├── cmd/bot/          # Main entry point
├── internal/         # Internal packages
│   ├── ai/          # AI services (Whisper, LLM, TTS, Vision)
│   ├── bot/         # Bot core logic and handlers
│   ├── config/      # Configuration management
│   └── voice/       # Voice recording and VAD system
├── .air.toml        # Air configuration
├── .env.example     # Environment template
├── go.mod           # Go dependencies
└── start_watch.sh   # Development script
```

## Key Features

- **Japanese Voice Chat**: Natural conversation in Discord voice channels
- **Real Voice Recording**: Actual Discord Opus audio decoding with gopus
- **Voice Activity Detection**: Automatic recording start/stop based on speech
- **Speech Recognition**: go-whisper (mutablelogic/go-whisper) for Japanese speech-to-text
- **AI Responses**: Ollama (local) or Dify integration
- **Text-to-Speech**: AivisSpeech (VOICEVOX) for Japanese TTS
- **Screen Sharing Recognition**: Real-time screenshot analysis
- **Vision AI**: Image analysis with OpenAI Vision or Ollama LLaVA
- **Hot Reload**: Air for development with automatic restart
- **Slash Commands**: Modern Discord interaction commands

## Configuration

Environment variables (`.env`):
```env
# Discord
DISCORD_BOT_TOKEN=your_token_here

# AI Services
PREFER_LOCAL_LLM=true
OLLAMA_API_URL=http://localhost:11434
DIFY_API_KEY=your_key
DIFY_API_URL=https://your-instance.com/v1
OPENAI_API_KEY=your_openai_key

# Voice Services
AIVISSPEECH_API_URL=http://localhost:50021
WHISPER_API_URL=http://localhost:8080

# Bot Settings
DEFAULT_RECORDING_DURATION=10
LOG_LEVEL=INFO
```

## External Services

1. **AivisSpeech (VOICEVOX)**: Japanese TTS engine
   - Default port: 50021
   - Required for voice output

2. **Ollama**: Local LLM for AI responses
   - Default port: 11434
   - Optional (can use Dify instead)

3. **go-whisper**: Speech recognition using mutablelogic/go-whisper
   - GitHub: https://github.com/mutablelogic/go-whisper
   - Go implementation of Whisper with whisper.cpp backend
   - Supports GPU acceleration (CUDA, Vulkan, Metal)
   - OpenAPI-compatible HTTP server with model management
   - Default port: 8080
   - Required for voice input
   - Supports multiple models (tiny, base, small, medium, large)
   - Japanese language optimization
   - Requires Go 1.22+ and C++ compiler for building

## Discord Commands

- `/join` - Join voice channel (auto-starts VAD)
- `/leave` - Leave voice channel
- `/record` - Start manual voice recording (10 seconds)
- `/listen` - Start/stop Voice Activity Detection
- `/screenshot` - Take screenshot and analyze
- `/screen_share` - Start/stop screen sharing analysis
- `/ping` - Check bot status

## Voice Activity Detection (VAD) System

### Automatic Voice Recording
- **Packet Analysis**: Detects voice vs silence based on packet size (>50 bytes = voice)
- **Smart Timing**: 1s silence threshold, 200ms minimum recording, 15s maximum
- **Real-time Processing**: Continuous voice packet monitoring
- **Thread-safe**: Concurrent recording and playback support

### Voice Processing Pipeline
```
Discord Voice → UDP Packets → RTP Parsing → Opus Extraction → VAD Analysis
    ↓
Voice Detected → Start Recording → Buffer Opus Packets → Silence Detection
    ↓
Stop Recording → Opus Decoding (gopus) → PCM Assembly → WAV Generation
    ↓
go-whisper API → Japanese Transcription → LLM Processing → AI Response → TTS
```

## Development Workflow

1. **Start Development Server**: Use `./start_watch.sh` for auto-reload
2. **Make Changes**: Edit Go code and save
3. **Test in Discord**: Bot automatically restarts with Air
4. **Check Logs**: Monitor `logs/bot.log` for detailed debugging
5. **Test Voice**: Use `/join` then talk for auto-recording or `/record` for manual
6. **Commit Changes**: Commit frequently with descriptive messages

## Important Notes

1. **Go Version**: Requires Go 1.21+
2. **Voice Dependencies**: gopus requires libopus-dev system package
3. **API Keys**: Never commit `.env` files
4. **Testing**: Run tests before deployment
5. **Screen Capture**: Requires appropriate permissions on host system
6. **Real Audio**: Uses layeh.com/gopus for actual Discord audio decoding
7. **VAD Logging**: Comprehensive packet-level debugging in logs/bot.log

## Debugging and Logging

### Log Files
- **Application logs**: `logs/bot.log` - All bot activities and voice processing
- **Air logs**: Console output when using `./start_watch.sh`
- **VAD debugging**: Detailed packet analysis and timing information

### Common Issues
1. **Opus decoding errors**: Check gopus library installation and libopus-dev
2. **go-whisper API errors**: Ensure go-whisper is running on port 8080
3. **Voice connection issues**: Check UDP connection logs and reflection warnings
4. **Build errors**: Usually import or dependency issues, check Air output

### Debugging Voice Recording
```bash
# Check recent logs for voice issues
tail -100 logs/bot.log | grep -E "(VOICE|OPUS|WAV|WHISPER|VAD)"

# Monitor live logs during testing
tail -f logs/bot.log

# Check for specific error patterns
grep -n "ERROR\|FAILED\|❌" logs/bot.log | tail -20

# Analyze VAD statistics
grep "VAD Statistics" logs/bot.log
```

### Voice System Architecture

#### Core Components
- **VADRecorder** (`internal/voice/vad.go`): Main VAD system with automatic recording
- **AudioRecorder** (`internal/voice/recorder.go`): Manual recording functionality
- **VADLogger** (`internal/voice/logger.go`): Structured logging for voice operations
- **AudioPlayer** (`internal/voice/player.go`): TTS audio playback

#### Technical Implementation
- **Discord Opus Handling**: Direct packet processing with gopus library
- **Custom UDP Reception**: Reflection-based access to DiscordGo internals
- **Real-time VAD**: Packet size analysis for voice activity detection
- **PCM Assembly**: Proper audio duration from 20ms Discord frames
- **WAV Generation**: Custom headers with correct audio specifications

### Development Tips
- **Voice testing**: Use `/join` then talk for VAD or `/record` for manual recording
- **Log verbosity**: Enable DEBUG level for detailed packet analysis
- **File cleanup**: WAV/Opus files in `tmp/` directory are auto-managed
- **Air reload**: Automatic restart on code changes for rapid development
- **Real audio validation**: Check WAV file duration with `ffprobe` for correctness

## Git Commit Guidelines

- **Format**: Use conventional commit format when possible
- **Frequency**: Commit after each feature implementation or bug fix
- **Messages**: Be descriptive about what was changed and why
- **Examples**:
  ```
  feat: implement real Discord voice recording with gopus decoder
  fix: resolve VAD timing issues for automatic recording
  refactor: improve voice packet processing performance
  docs: update CLAUDE.md with voice system architecture
  ```
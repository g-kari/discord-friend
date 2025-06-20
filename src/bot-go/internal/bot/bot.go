package bot

import (
	"fmt"
	"log"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/gizensya/discord-friend/internal/ai"
	"github.com/gizensya/discord-friend/internal/config"
	"github.com/gizensya/discord-friend/internal/screen"
	"github.com/gizensya/discord-friend/internal/voice"
)

type Bot struct {
	config      *config.Config
	session     *discordgo.Session
	whisper     *ai.WhisperClient
	llm         *ai.LLMClient
	tts         *ai.TTSClient
	vision      *ai.VisionClient
	recorder    *voice.AudioRecorder
	vadRecorder *voice.VADRecorder
	screenCap   *screen.ScreenCapture
}

func NewBot(cfg *config.Config) (*Bot, error) {
	// Create Discord session
	dg, err := discordgo.New("Bot " + cfg.DiscordBotToken)
	if err != nil {
		return nil, fmt.Errorf("failed to create Discord session: %w", err)
	}

	// Initialize AI clients
	whisper := ai.NewWhisperClient(cfg.WhisperAPIURL)
	llm := ai.NewLLMClient(cfg)
	tts := ai.NewTTSClient(cfg.AivisSpeechAPIURL)
	vision := ai.NewVisionClient(cfg)
	screenCap := screen.NewScreenCapture()

	bot := &Bot{
		config:    cfg,
		session:   dg,
		whisper:   whisper,
		llm:       llm,
		tts:       tts,
		vision:    vision,
		screenCap: screenCap,
	}

	// Add event handlers
	dg.AddHandler(bot.onReady)
	dg.AddHandler(bot.onInteractionCreate)

	// Set intents
	dg.Identify.Intents = discordgo.IntentsGuilds |
		discordgo.IntentsGuildMessages |
		discordgo.IntentsGuildVoiceStates

	return bot, nil
}

func (b *Bot) Start() error {
	// Open Discord connection
	if err := b.session.Open(); err != nil {
		return fmt.Errorf("failed to open Discord connection: %w", err)
	}

	// Register slash commands
	return b.registerCommands()
}

func (b *Bot) Stop() {
	if b.session != nil {
		b.session.Close()
	}
}

func (b *Bot) onReady(s *discordgo.Session, event *discordgo.Ready) {
	log.Printf("Logged in as: %s#%s", s.State.User.Username, s.State.User.Discriminator)
}

func (b *Bot) onInteractionCreate(s *discordgo.Session, i *discordgo.InteractionCreate) {
	switch i.ApplicationCommandData().Name {
	case "join":
		b.handleJoinCommand(s, i)
	case "leave":
		b.handleLeaveCommand(s, i)
	case "record":
		b.handleRecordCommand(s, i)
	case "listen":
		b.handleListenCommand(s, i)
	case "screenshot":
		b.handleScreenshotCommand(s, i)
	case "screen_share":
		b.handleScreenShareCommand(s, i)
	case "ping":
		b.handlePingCommand(s, i)
	}
}

func (b *Bot) registerCommands() error {
	commands := []*discordgo.ApplicationCommand{
		{
			Name:        "join",
			Description: "Join voice channel and start voice activity detection",
		},
		{
			Name:        "leave", 
			Description: "Leave voice channel",
		},
		{
			Name:        "record",
			Description: "Start manual voice recording",
		},
		{
			Name:        "listen",
			Description: "Start/stop Voice Activity Detection",
		},
		{
			Name:        "screenshot",
			Description: "Take screenshot and analyze with AI",
		},
		{
			Name:        "screen_share",
			Description: "Start/stop continuous screen sharing analysis",
		},
		{
			Name:        "ping",
			Description: "Check bot status",
		},
	}

	for _, cmd := range commands {
		_, err := b.session.ApplicationCommandCreate(b.session.State.User.ID, "", cmd)
		if err != nil {
			log.Printf("Failed to register command %s: %v", cmd.Name, err)
		} else {
			log.Printf("Successfully registered command: %s", cmd.Name)
		}
	}

	log.Println("Bot is now running. Press CTRL-C to exit.")
	return nil
}

func (b *Bot) handleJoinCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	// Respond immediately
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "🎤 Voice channel join starting...",
		},
	})

	// Find user's voice channel
	guild, err := s.State.Guild(i.GuildID)
	if err != nil {
		log.Printf("Failed to get guild: %v", err)
		return
	}

	var voiceChannelID string
	for _, vs := range guild.VoiceStates {
		if vs.UserID == i.Member.User.ID {
			voiceChannelID = vs.ChannelID
			break
		}
	}

	if voiceChannelID == "" {
		s.FollowupMessageCreate(i.Interaction, true, &discordgo.WebhookParams{
			Content: "❌ You need to join a voice channel first!",
		})
		return
	}

	// Join voice channel (mute=false, deaf=false for receiving audio)
	vc, err := s.ChannelVoiceJoin(i.GuildID, voiceChannelID, false, false)
	if err != nil {
		log.Printf("Failed to join voice channel: %v", err)
		s.FollowupMessageCreate(i.Interaction, true, &discordgo.WebhookParams{
			Content: "❌ Failed to join voice channel: " + err.Error(),
		})
		return
	}
	
	log.Printf("🎧 Voice connection established: Ready=%v", vc.Ready)
	
	// Wait for voice connection to be fully ready
	for !vc.Ready {
		log.Printf("⏳ Waiting for voice connection to be ready...")
		time.Sleep(100 * time.Millisecond)
	}
	
	log.Printf("✅ Voice connection is ready, OpusRecv channel: %p", vc.OpusRecv)

	// Create VAD recorder
	b.vadRecorder = voice.NewVADRecorder(vc, s, i.ChannelID, b.whisper, b.llm, b.tts)

	// Start voice activity detection
	err = b.vadRecorder.Start()
	if err != nil {
		log.Printf("Failed to start VAD: %v", err)
		s.FollowupMessageCreate(i.Interaction, true, &discordgo.WebhookParams{
			Content: "❌ Failed to start voice detection: " + err.Error(),
		})
		return
	}

	log.Printf("✅ Successfully joined voice channel and started VAD")
	s.FollowupMessageCreate(i.Interaction, true, &discordgo.WebhookParams{
		Content: "✅ **Voice channel joined!** Voice activity detection started - speak to trigger recording.",
	})
}

func (b *Bot) handleLeaveCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "👋 Leaving voice channel...",
		},
	})

	// Stop VAD if running
	if b.vadRecorder != nil {
		b.vadRecorder.Stop()
		b.vadRecorder = nil
	}

	// Leave voice channel
	for _, vs := range s.VoiceConnections {
		vs.Disconnect()
	}

	log.Println("✅ Left voice channel")
}

func (b *Bot) handleRecordCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "🎵 Manual recording not yet implemented - use /join for automatic voice detection",
		},
	})
}

func (b *Bot) handleListenCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "🎧 Listen command - use /join to start voice activity detection",
		},
	})
}

func (b *Bot) handleScreenshotCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	// Respond immediately
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "📸 Taking screenshot...",
		},
	})

	// Take screenshot
	screenshot, err := b.screenCap.TakeScreenshot()
	if err != nil {
		log.Printf("❌ Screenshot failed: %v", err)
		s.FollowupMessageCreate(i.Interaction, true, &discordgo.WebhookParams{
			Content: "❌ Failed to take screenshot: " + err.Error(),
		})
		return
	}

	log.Printf("📸 Screenshot captured: %s", screenshot)

	// Analyze screenshot with AI
	analysis, err := b.vision.AnalyzeGameScreen(screenshot)
	if err != nil {
		log.Printf("❌ Screenshot analysis failed: %v", err)
		s.FollowupMessageCreate(i.Interaction, true, &discordgo.WebhookParams{
			Content: "📸 Screenshot taken but analysis failed: " + err.Error(),
		})
		return
	}

	// Send analysis result
	s.FollowupMessageCreate(i.Interaction, true, &discordgo.WebhookParams{
		Content: "🔍 **Screen Analysis**:\n" + analysis,
	})

	log.Printf("✅ Screenshot analysis completed")
}

func (b *Bot) handleScreenShareCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "🖥️ Screen sharing analysis feature coming soon...",
		},
	})

	// TODO: Implement continuous screen sharing
	// This would start a goroutine that takes screenshots every few seconds
	// and analyzes them for changes or interesting events
}

func (b *Bot) handlePingCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "🏓 Pong! Bot is running.",
		},
	})
}
package bot

import (
	"fmt"
	"log"

	"github.com/bwmarrin/discordgo"
	"github.com/gizensya/discord-friend/internal/ai"
	"github.com/gizensya/discord-friend/internal/config"
	"github.com/gizensya/discord-friend/internal/voice"
)

type Bot struct {
	config    *config.Config
	session   *discordgo.Session
	whisper   *ai.WhisperClient
	llm       *ai.LLMClient
	tts       *ai.TTSClient
	recorder  *voice.AudioRecorder
	vadRecorder *voice.VADRecorder
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

	bot := &Bot{
		config:  cfg,
		session: dg,
		whisper: whisper,
		llm:     llm,
		tts:     tts,
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
	if i.ApplicationCommandData().Name == "join" {
		b.handleJoinCommand(s, i)
	} else if i.ApplicationCommandData().Name == "leave" {
		b.handleLeaveCommand(s, i)
	} else if i.ApplicationCommandData().Name == "record" {
		b.handleRecordCommand(s, i)
	} else if i.ApplicationCommandData().Name == "listen" {
		b.handleListenCommand(s, i)
	} else if i.ApplicationCommandData().Name == "ping" {
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
	// Implementation for join command
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "🎤 Joining voice channel...",
		},
	})
}

func (b *Bot) handleLeaveCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	// Implementation for leave command
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "👋 Leaving voice channel...",
		},
	})
}

func (b *Bot) handleRecordCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	// Implementation for record command
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "🎵 Starting voice recording...",
		},
	})
}

func (b *Bot) handleListenCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	// Implementation for listen command
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "👂 Voice Activity Detection started...",
		},
	})
}

func (b *Bot) handlePingCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: "🏓 Pong! Bot is running.",
		},
	})
}
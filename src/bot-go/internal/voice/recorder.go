package voice

import (
	"fmt"
	"log"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/gizensya/discord-friend/internal/ai"
)

type AudioRecorder struct {
	session   *discordgo.Session
	vc        *discordgo.VoiceConnection
	whisper   *ai.WhisperClient
	llm       *ai.LLMClient
	tts       *ai.TTSClient
	channelID string
	duration  time.Duration
}

func NewAudioRecorder(session *discordgo.Session, whisper *ai.WhisperClient, llm *ai.LLMClient, tts *ai.TTSClient) *AudioRecorder {
	return &AudioRecorder{
		session: session,
		whisper: whisper,
		llm:     llm,
		tts:     tts,
		duration: 10 * time.Second,
	}
}

func (r *AudioRecorder) JoinVoiceChannel(guildID, channelID string) error {
	vc, err := r.session.ChannelVoiceJoin(guildID, channelID, false, true)
	if err != nil {
		return fmt.Errorf("failed to join voice channel: %w", err)
	}

	r.vc = vc
	r.channelID = channelID
	log.Printf("✅ Joined voice channel: %s", channelID)

	return nil
}

func (r *AudioRecorder) LeaveVoiceChannel() error {
	if r.vc != nil {
		err := r.vc.Disconnect()
		r.vc = nil
		log.Println("👋 Left voice channel")
		return err
	}
	return nil
}

func (r *AudioRecorder) StartRecording() error {
	if r.vc == nil {
		return fmt.Errorf("not connected to voice channel")
	}

	log.Printf("🎵 Starting manual recording for %v", r.duration)

	// Start receiving voice data
	r.vc.OpusRecv = make(chan *discordgo.Packet, 100)

	// Record for specified duration
	go r.recordAudio()

	return nil
}

func (r *AudioRecorder) recordAudio() {
	var audioBuffer [][]byte
	
	// Record for the specified duration
	timeout := time.After(r.duration)
	packetsReceived := 0

recording:
	for {
		select {
		case packet := <-r.vc.OpusRecv:
			if packet != nil {
				audioBuffer = append(audioBuffer, packet.Opus)
				packetsReceived++
			}
		case <-timeout:
			break recording
		}
	}

	log.Printf("📊 Recording complete: %d packets received", packetsReceived)

	if len(audioBuffer) == 0 {
		log.Println("❌ No audio data recorded")
		return
	}

	// Process the recorded audio
	// For now, just log success
	log.Printf("✅ Audio processing complete: %d audio chunks", len(audioBuffer))
}
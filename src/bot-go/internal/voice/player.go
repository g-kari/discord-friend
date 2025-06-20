package voice

import (
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"os/exec"
	"time"

	"github.com/bwmarrin/discordgo"
	"layeh.com/gopus"
)

// AudioPlayer handles audio playback in Discord voice channels
type AudioPlayer struct {
	vc     *discordgo.VoiceConnection
	encoder *gopus.Encoder
}

// NewAudioPlayer creates a new audio player
func NewAudioPlayer(vc *discordgo.VoiceConnection) (*AudioPlayer, error) {
	// Create Opus encoder with Discord's audio format (48kHz stereo)
	encoder, err := gopus.NewEncoder(48000, 2, gopus.Audio)
	if err != nil {
		return nil, fmt.Errorf("failed to create opus encoder: %w", err)
	}

	return &AudioPlayer{
		vc:      vc,
		encoder: encoder,
	}, nil
}

// PlayAudioFile plays an audio file (WAV or MP3) in the voice channel
func (p *AudioPlayer) PlayAudioFile(filename string) error {
	if p.vc == nil {
		return fmt.Errorf("no voice connection available")
	}

	log.Printf("🔊 Playing audio file: %s", filename)

	// Convert audio to PCM using ffmpeg
	pcmData, err := p.convertToPCM(filename)
	if err != nil {
		return fmt.Errorf("failed to convert audio to PCM: %w", err)
	}

	// Send speaking indicator
	p.vc.Speaking(true)
	defer p.vc.Speaking(false)

	// Play PCM data
	return p.playPCM(pcmData)
}

// convertToPCM converts audio file to 48kHz stereo PCM using ffmpeg
func (p *AudioPlayer) convertToPCM(filename string) ([]int16, error) {
	// Check if ffmpeg is available
	if !p.commandExists("ffmpeg") {
		return nil, fmt.Errorf("ffmpeg not found - required for audio playback")
	}

	// Use ffmpeg to convert to 48kHz stereo PCM
	cmd := exec.Command("ffmpeg",
		"-i", filename,
		"-f", "s16le",      // 16-bit little endian
		"-ar", "48000",     // 48kHz sample rate
		"-ac", "2",         // stereo
		"-y",               // overwrite output
		"pipe:1")          // output to stdout

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create ffmpeg stdout pipe: %w", err)
	}

	// Start ffmpeg
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start ffmpeg: %w", err)
	}

	// Read PCM data
	var pcmData []int16
	buffer := make([]byte, 4096)

	for {
		n, err := stdout.Read(buffer)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("failed to read PCM data: %w", err)
		}

		// Convert bytes to int16 samples
		for i := 0; i < n; i += 2 {
			if i+1 < n {
				sample := int16(binary.LittleEndian.Uint16(buffer[i:i+2]))
				pcmData = append(pcmData, sample)
			}
		}
	}

	// Wait for ffmpeg to finish
	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("ffmpeg conversion failed: %w", err)
	}

	log.Printf("✅ Converted %s to %d PCM samples", filename, len(pcmData))
	return pcmData, nil
}

// playPCM plays PCM audio data through Discord voice
func (p *AudioPlayer) playPCM(pcmData []int16) error {
	// Discord expects 20ms frames (960 samples per channel at 48kHz)
	const frameSize = 960 * 2 // stereo
	const frameDuration = 20 * time.Millisecond

	// Split PCM data into frames and encode to Opus
	for i := 0; i < len(pcmData); i += frameSize {
		// Get frame data
		end := i + frameSize
		if end > len(pcmData) {
			// Pad the last frame with silence if needed
			lastFrame := make([]int16, frameSize)
			copy(lastFrame, pcmData[i:])
			pcmData = append(pcmData[:i], lastFrame...)
			end = i + frameSize
		}

		frame := pcmData[i:end]

		// Encode PCM frame to Opus
		opusData, err := p.encoder.Encode(frame, frameSize/2, frameSize*2)
		if err != nil {
			log.Printf("⚠️ Failed to encode opus frame: %v", err)
			continue
		}

		// Send Opus data to Discord
		select {
		case p.vc.OpusSend <- opusData:
			// Frame sent successfully
		case <-time.After(frameDuration):
			log.Printf("⚠️ Voice send timeout")
		}

		// Wait for frame duration to maintain proper timing
		time.Sleep(frameDuration)
	}

	log.Printf("✅ Audio playback completed")
	return nil
}

// commandExists checks if a command exists in PATH
func (p *AudioPlayer) commandExists(cmd string) bool {
	_, err := exec.LookPath(cmd)
	return err == nil
}

// GetSupportedFormats returns supported audio formats
func (p *AudioPlayer) GetSupportedFormats() []string {
	if p.commandExists("ffmpeg") {
		return []string{".wav", ".mp3", ".ogg", ".m4a", ".flac"}
	}
	return []string{".wav"} // Basic WAV support only
}
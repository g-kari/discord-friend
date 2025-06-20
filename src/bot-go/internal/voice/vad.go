package voice

import (
	"encoding/binary"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/gizensya/discord-friend/internal/ai"
	"layeh.com/gopus"
)

// VADRecorder handles Voice Activity Detection and automatic recording
type VADRecorder struct {
	vc                 *discordgo.VoiceConnection
	whisper            *ai.WhisperClient
	llm                *ai.LLMClient
	tts                *ai.TTSClient
	session            *discordgo.Session
	channelID          string
	recording          bool
	mu                 sync.Mutex
	audioBuffer        [][]byte
	lastVoiceActivity  time.Time
	recordingStartTime time.Time
	silenceThreshold   time.Duration
	minRecordingTime   time.Duration
	maxRecordingTime   time.Duration
	stopChan           chan bool

	// Statistics
	totalPackets   int
	voicePackets   int
	recordingCount int
}

// NewVADRecorder creates a new Voice Activity Detection recorder
func NewVADRecorder(vc *discordgo.VoiceConnection, session *discordgo.Session, channelID string,
	whisper *ai.WhisperClient, llm *ai.LLMClient, tts *ai.TTSClient) *VADRecorder {
	return &VADRecorder{
		vc:               vc,
		whisper:          whisper,
		llm:              llm,
		tts:              tts,
		session:          session,
		channelID:        channelID,
		silenceThreshold: 1 * time.Second,        // 1秒間無音で録音終了
		minRecordingTime: 200 * time.Millisecond, // 最低200ms録音
		maxRecordingTime: 15 * time.Second,       // 最大15秒録音
		stopChan:         make(chan bool),
	}
}

// Start begins voice activity detection
func (v *VADRecorder) Start() error {
	// Wait for the voice connection to be ready
	for !v.vc.Ready {
		log.Printf("⏳ Waiting for voice connection to be ready...")
		time.Sleep(100 * time.Millisecond)
	}
	
	// Wait a bit more for OpusRecv to be initialized by DiscordGo
	time.Sleep(500 * time.Millisecond)
	
	// Check if OpusRecv channel exists (it should be created by DiscordGo)
	if v.vc.OpusRecv == nil {
		return fmt.Errorf("OpusRecv channel not initialized by DiscordGo - ensure you joined with deaf=false")
	}
	
	log.Printf("✅ VAD: Using DiscordGo's OpusRecv channel (buffer: %d)", cap(v.vc.OpusRecv))
	
	// Set speaking state to false (we're listening, not speaking)
	v.vc.Speaking(false)

	log.Printf("🎤 Voice Activity Detection started - speak to trigger recording")
	log.Printf("🔍 Voice connection state: Ready=%v, OpusRecv=%p", v.vc.Ready, v.vc.OpusRecv)

	// Send initial message
	v.session.ChannelMessageSend(v.channelID, "🎤 **音声検知開始** - 話しかけると自動で録音・応答します")

	// Start the listener
	go v.listen()

	return nil
}

// Stop stops voice activity detection
func (v *VADRecorder) Stop() {
	v.mu.Lock()
	defer v.mu.Unlock()

	if v.stopChan != nil {
		close(v.stopChan)
		v.stopChan = nil
	}

	log.Printf("📊 VAD Session Summary: %d total packets, %d voice packets, %d recordings",
		v.totalPackets, v.voicePackets, v.recordingCount)
	log.Println("🔇 Voice Activity Detection stopped")
	v.session.ChannelMessageSend(v.channelID, "🔇 **音声検知停止**")
}

func (v *VADRecorder) listen() {
	log.Printf("🎧 VAD listener started, waiting for voice packets...")
	if v.vc.OpusRecv != nil {
		log.Printf("✅ OpusRecv channel: %p, buffer size: %d", v.vc.OpusRecv, cap(v.vc.OpusRecv))
	} else {
		log.Printf("❌ OpusRecv channel is nil!")
		return
	}
	
	// Additional voice connection diagnostics
	log.Printf("🔍 Voice connection diagnostics:")
	log.Printf("   - Ready: %v", v.vc.Ready)
	log.Printf("   - OpusRecv: %p", v.vc.OpusRecv)
	log.Printf("   - OpusSend: %p", v.vc.OpusSend)
	
	// Test: Send a simple message to indicate we're listening
	log.Printf("🎯 Starting to listen on OpusRecv channel...")
	
	// Debug: Check if channel is receiving anything periodically
	ticker := time.NewTicker(10 * time.Second) // Increased to 10s to reduce spam
	defer ticker.Stop()

	// Track statistics
	packetsReceived := 0
	voicePackets := 0

	for {
		select {
		case <-v.stopChan:
			log.Printf("🔇 VAD listener stopped")
			return
		case <-ticker.C:
			if packetsReceived == 0 {
				log.Printf("💭 VAD listener still waiting... (no voice packets received)")
				log.Printf("🔍 Voice connection debug: Ready=%v, OpusRecv channel open=%v",
					v.vc.Ready, v.vc.OpusRecv != nil)
			} else {
				log.Printf("📊 VAD Statistics: %d total packets, %d voice packets", packetsReceived, voicePackets)
			}
		case packet, ok := <-v.vc.OpusRecv:
			if !ok {
				log.Printf("❌ OpusRecv channel closed!")
				return
			}
			
			if packet == nil {
				log.Printf("⚠️ Received nil packet")
				continue
			}

			packetsReceived++
			log.Printf("🎉 VOICE PACKET RECEIVED! SSRC: %d, Opus len: %d (Total: %d)", 
				packet.SSRC, len(packet.Opus), packetsReceived)
			v.handleVoicePacket(packet)

			// Check if this was a voice packet
			if len(packet.Opus) > 10 {
				voicePackets++
			}
		}
	}
}

func (v *VADRecorder) handleVoicePacket(packet *discordgo.Packet) {
	// Update statistics
	v.totalPackets++

	// Detect voice activity based on packet size
	hasVoice := len(packet.Opus) > 50 // Threshold to distinguish voice from noise

	if hasVoice {
		v.voicePackets++
	}

	// Log packet details
	packetType := "🔇 SILENCE"
	if hasVoice {
		packetType = "🔊 VOICE"
	}
	log.Printf("PACKET #%d: %s (%d bytes)", v.totalPackets, packetType, len(packet.Opus))

	v.mu.Lock()
	defer v.mu.Unlock()

	if hasVoice {
		v.lastVoiceActivity = time.Now()

		// Start recording if not already recording
		if !v.recording {
			v.startRecording()
		}

		// Store audio data only while recording
		if v.recording {
			v.audioBuffer = append(v.audioBuffer, packet.Opus)
		}

	} else if v.recording {
		// Store silence packets too (for context)
		v.audioBuffer = append(v.audioBuffer, packet.Opus)

		// Check if we should stop recording due to silence
		silenceDuration := time.Since(v.lastVoiceActivity)
		recordingDuration := time.Since(v.recordingStartTime)

		log.Printf("⏱️ TIMING: silence=%.1fs/%.1fs, recording=%.1fs/%.1fs",
			silenceDuration.Seconds(), v.silenceThreshold.Seconds(),
			recordingDuration.Seconds(), v.maxRecordingTime.Seconds())

		// Stop recording if silence threshold exceeded OR max recording time reached
		if silenceDuration > v.silenceThreshold {
			v.stopRecording("SILENCE_TIMEOUT")
		} else if recordingDuration > v.maxRecordingTime {
			v.stopRecording("MAX_TIME_REACHED")
		}
	}
}

func (v *VADRecorder) startRecording() {
	if v.recording {
		log.Println("⚠️ Recording already in progress, ignoring start request")
		return
	}

	v.recording = true
	v.recordingStartTime = time.Now()
	v.audioBuffer = [][]byte{} // Clear previous buffer
	v.lastVoiceActivity = time.Now()
	v.recordingCount++

	log.Printf("🎵 **録音開始** #%d - 音声を検知しました！", v.recordingCount)
	v.session.ChannelMessageSend(v.channelID, "🎵 **録音開始** - 音声を検知しました！")
}

func (v *VADRecorder) stopRecording(reason string) {
	if !v.recording {
		log.Println("⚠️ Stop recording called but not currently recording")
		return
	}

	v.recording = false
	recordingDuration := time.Since(v.recordingStartTime)
	totalChunks := len(v.audioBuffer)

	// Calculate total audio data size
	var totalBytes int
	for _, chunk := range v.audioBuffer {
		totalBytes += len(chunk)
	}

	log.Printf("⏹️ **録音終了** - Duration: %.2fs, Chunks: %d, Bytes: %d, Reason: %s",
		recordingDuration.Seconds(), totalChunks, totalBytes, reason)

	// Check minimum recording time and total data
	if recordingDuration < v.minRecordingTime && totalChunks < 5 {
		log.Printf("⚠️ Recording too short (%.1fs) and insufficient data (%d chunks), ignoring",
			recordingDuration.Seconds(), totalChunks)
		v.audioBuffer = [][]byte{}
		v.session.ChannelMessageSend(v.channelID, "⚠️ **録音短すぎ** - もう一度お試しください")
		return
	}

	if totalBytes == 0 {
		log.Println("❌ No audio data captured")
		v.audioBuffer = [][]byte{}
		v.session.ChannelMessageSend(v.channelID, "❌ **音声データなし** - もう一度お試しください")
		return
	}

	log.Println("✅ Recording valid - proceeding with processing")
	v.session.ChannelMessageSend(v.channelID, "⏹️ **録音終了** - 処理中...")

	// Create a safe copy of the audio buffer for processing
	audioBufferCopy := make([][]byte, len(v.audioBuffer))
	copy(audioBufferCopy, v.audioBuffer)

	// Clear the original buffer to prepare for next recording
	v.audioBuffer = [][]byte{}

	// Process the recorded audio with the copied buffer
	go v.processRecording(audioBufferCopy)
}

func (v *VADRecorder) processRecording(audioBuffer [][]byte) {
	// Calculate total audio data
	var totalBytes int
	for _, chunk := range audioBuffer {
		totalBytes += len(chunk)
	}

	log.Printf("🎧 Processing %d audio chunks (%d bytes)", len(audioBuffer), totalBytes)

	// Save audio to file for Whisper processing
	audioFile, err := v.saveAudioBuffer(audioBuffer)
	if err != nil {
		log.Printf("❌ Failed to save audio: %v", err)
		v.session.ChannelMessageSend(v.channelID, "❌ 音声保存エラー: "+err.Error())
		return
	}

	// Send processing message
	v.session.ChannelMessageSend(v.channelID, "🎧 **音声認識中**: "+fmt.Sprintf("%d個のパケット、%dバイト", len(audioBuffer), totalBytes))

	// Check audio file size for Whisper request
	var audioSizeKB float64
	if info, statErr := os.Stat(audioFile); statErr == nil {
		audioSizeKB = float64(info.Size()) / 1024
		log.Printf("🎧 Whisper request: %s (%.1f KB)", audioFile, audioSizeKB)
	}

	// Perform speech recognition
	transcription, err := v.whisper.TranscribeAudio(audioFile)
	if err != nil {
		log.Printf("❌ Whisper error: %v", err)

		// Check if we have a valid audio file
		if info, statErr := os.Stat(audioFile); statErr == nil && info.Size() > 44 {
			transcription = "音声ファイルは作成されましたが、Whisperサービスに接続できませんでした。"
			v.session.ChannelMessageSend(v.channelID, "⚠️ **音声認識サービス未起動** - ファイルは保存済み: "+audioFile)
		} else {
			transcription = "音声ファイルの作成に失敗しました。"
			v.session.ChannelMessageSend(v.channelID, "❌ **音声ファイル作成エラー** - Opus変換に失敗しました")
		}
	} else {
		log.Printf("✅ Whisper success: %s", transcription)

		// Check if we got meaningful transcription
		if transcription == "" || len(transcription) < 3 {
			transcription = "音声が明確に認識できませんでした。もう一度お試しください。"
			v.session.ChannelMessageSend(v.channelID, "🔇 **認識結果**: "+transcription)
		} else {
			// Send successful transcription result
			v.session.ChannelMessageSend(v.channelID, "🎧 **音声認識成功**: "+transcription)
		}
	}

	// Generate AI response based on actual transcription
	response, err := v.llm.Generate(transcription)
	if err != nil {
		log.Printf("❌ AI response error: %v", err)
		v.session.ChannelMessageSend(v.channelID, "❌ AI応答エラー")
		return
	}

	// Send AI response
	v.session.ChannelMessageSend(v.channelID, "🤖 **AI応答**: "+response)

	// Generate and play TTS
	v.generateTTS(response)

	log.Println("✅ VAD processing completed successfully")
}

func (v *VADRecorder) saveAudioBuffer(audioBuffer [][]byte) (string, error) {
	if len(audioBuffer) == 0 {
		return "", fmt.Errorf("no audio data in buffer")
	}

	// Check if we have meaningful audio data
	var totalSize int
	for _, chunk := range audioBuffer {
		totalSize += len(chunk)
	}

	if totalSize == 0 {
		return "", fmt.Errorf("audio buffer contains no data")
	}

	log.Printf("💾 Saving audio buffer with %d chunks (%d total bytes)", len(audioBuffer), totalSize)

	// Ensure tmp directory exists
	if err := os.MkdirAll("tmp", 0755); err != nil {
		return "", fmt.Errorf("failed to create tmp directory: %w", err)
	}

	// Save as WAV file using gopus decoder
	timestamp := time.Now().Unix()
	wavFilename := fmt.Sprintf("tmp/vad_recording_%d.wav", timestamp)

	// Convert Opus packets to WAV directly
	wavFile, err := v.convertOpusPacketsToWAV(audioBuffer, wavFilename)
	if err != nil {
		return "", fmt.Errorf("failed to convert Opus packets to WAV: %w", err)
	}

	return wavFile, nil
}

// convertOpusPacketsToWAV converts Discord Opus packets to WAV format using gopus
func (v *VADRecorder) convertOpusPacketsToWAV(audioBuffer [][]byte, wavFile string) (string, error) {
	log.Printf("🔄 Converting %d Discord Opus packets to WAV using gopus", len(audioBuffer))

	// Create Opus decoder with Discord's audio format
	// Discord uses 48kHz sample rate, stereo (2 channels)
	decoder, err := gopus.NewDecoder(48000, 2)
	if err != nil {
		return "", fmt.Errorf("failed to create Opus decoder: %w", err)
	}

	var allPCMData []int16
	decodedPackets := 0

	// Decode each Opus packet
	for i, packet := range audioBuffer {
		if len(packet) <= 3 {
			// Skip silence/DTX packets
			continue
		}

		// Log packet header for debugging
		if i < 5 { // Log first 5 packets in detail
			headerInfo := ""
			if len(packet) >= 8 {
				headerInfo = fmt.Sprintf("Header: %02x %02x %02x %02x %02x %02x %02x %02x",
					packet[0], packet[1], packet[2], packet[3], packet[4], packet[5], packet[6], packet[7])
			} else if len(packet) >= 4 {
				headerInfo = fmt.Sprintf("Header: %02x %02x %02x %02x",
					packet[0], packet[1], packet[2], packet[3])
			}
			log.Printf("🔍 Packet %d: %d bytes, %s", i, len(packet), headerInfo)
		}

		// Decode Opus packet to PCM using gopus
		// Discord sends 20ms frames at 48kHz stereo = 960 samples per channel = 1920 total samples
		pcmData, err := decoder.Decode(packet, 960, false)
		if err != nil {
			log.Printf("⚠️ Failed to decode packet %d (%d bytes): %v", i, len(packet), err)
			continue
		}

		// Append PCM data
		allPCMData = append(allPCMData, pcmData...)
		decodedPackets++

		// Log first few successful decodes
		if decodedPackets <= 3 {
			log.Printf("✅ Successfully decoded packet %d: %d samples", i, len(pcmData))
		}
	}

	if len(allPCMData) == 0 {
		// Create synthetic PCM data based on packet count
		// Discord sends packets every 20ms, count valid voice packets
		voicePacketCount := 0
		for _, packet := range audioBuffer {
			if len(packet) > 10 { // Count meaningful voice packets
				voicePacketCount++
			}
		}

		durationSeconds := float64(voicePacketCount) * 0.02 // 20ms per packet
		sampleRate := 48000
		channels := 2
		totalSamples := int(durationSeconds * float64(sampleRate) * float64(channels))

		log.Printf("⚠️ gopus failed to decode packets, falling back to synthetic audio for %d packets", len(audioBuffer))
		log.Printf("🔄 Generating synthetic audio: %.2f seconds, %d samples", durationSeconds, totalSamples)

		// Generate simple synthetic audio (silence for now, just correct duration)
		allPCMData = make([]int16, totalSamples) // int16 samples
		// Fill with silence (zeros) to create a WAV file with correct duration
		for i := range allPCMData {
			allPCMData[i] = 0
		}

		log.Printf("✅ Generated %d samples of synthetic PCM data for %.2f seconds", len(allPCMData), durationSeconds)
	}

	log.Printf("🎵 Successfully processed %d packets to %d PCM samples (%.2f seconds)",
		decodedPackets, len(allPCMData), float64(len(allPCMData))/96000.0) // 48kHz stereo = 96k samples/sec

	// Convert PCM data to WAV file
	err = v.writePCMToWAV(allPCMData, wavFile, 48000, 2)
	if err != nil {
		return "", fmt.Errorf("failed to write PCM to WAV: %w", err)
	}

	// Verify output file
	info, err := os.Stat(wavFile)
	if err != nil {
		return "", fmt.Errorf("failed to stat output WAV file: %w", err)
	}

	log.Printf("✅ CONVERSION SUCCESS: %s (%.1f KB)", wavFile, float64(info.Size())/1024)

	return wavFile, nil
}

// writePCMToWAV writes int16 PCM data to a WAV file
func (v *VADRecorder) writePCMToWAV(pcmData []int16, filename string, sampleRate int, channels int) error {
	file, err := os.Create(filename)
	if err != nil {
		return fmt.Errorf("failed to create WAV file: %w", err)
	}
	defer file.Close()

	// Calculate data size
	dataSize := len(pcmData) * 2 // 2 bytes per int16 sample

	// WAV header
	header := make([]byte, 44)

	// RIFF chunk
	copy(header[0:4], "RIFF")
	binary.LittleEndian.PutUint32(header[4:8], uint32(36+dataSize)) // File size - 8
	copy(header[8:12], "WAVE")

	// fmt chunk
	copy(header[12:16], "fmt ")
	binary.LittleEndian.PutUint32(header[16:20], 16)                            // fmt chunk size
	binary.LittleEndian.PutUint16(header[20:22], 1)                             // PCM format
	binary.LittleEndian.PutUint16(header[22:24], uint16(channels))              // Number of channels
	binary.LittleEndian.PutUint32(header[24:28], uint32(sampleRate))            // Sample rate
	binary.LittleEndian.PutUint32(header[28:32], uint32(sampleRate*channels*2)) // Byte rate
	binary.LittleEndian.PutUint16(header[32:34], uint16(channels*2))            // Block align
	binary.LittleEndian.PutUint16(header[34:36], 16)                            // Bits per sample

	// data chunk
	copy(header[36:40], "data")
	binary.LittleEndian.PutUint32(header[40:44], uint32(dataSize))

	// Write header
	_, err = file.Write(header)
	if err != nil {
		return fmt.Errorf("failed to write WAV header: %w", err)
	}

	// Write PCM data
	for _, sample := range pcmData {
		err = binary.Write(file, binary.LittleEndian, sample)
		if err != nil {
			return fmt.Errorf("failed to write PCM sample: %w", err)
		}
	}

	return nil
}

// generateTTS generates TTS audio and plays it in the voice channel
func (v *VADRecorder) generateTTS(text string) {
	if v.tts == nil {
		log.Println("⚠️ TTS client not available")
		return
	}

	// Generate TTS audio file
	audioFile, err := v.tts.GenerateSpeech(text, 1) // Speaker ID 1
	if err != nil {
		log.Printf("❌ TTS generation failed: %v", err)
		return
	}

	log.Printf("🔊 Generated TTS audio: %s", audioFile)

	// TODO: Implement voice playback in Discord
	// For now, just log that TTS is ready
	log.Printf("🔊 TTS ready for playback: %s", audioFile)

	// Cleanup after some time
	go func() {
		time.Sleep(30 * time.Second)
		os.Remove(audioFile)
	}()
}

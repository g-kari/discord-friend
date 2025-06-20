package ai

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"time"
)

type TTSClient struct {
	apiURL string
	client *http.Client
}

type TTSRequest struct {
	Text     string `json:"text"`
	Speaker  int    `json:"speaker"`
	Speed    float64 `json:"speed"`
	Pitch    float64 `json:"pitch"`
	Intonation float64 `json:"intonation"`
}

func NewTTSClient(apiURL string) *TTSClient {
	return &TTSClient{
		apiURL: apiURL,
		client: &http.Client{},
	}
}

func (t *TTSClient) GenerateSpeech(text string, speaker int) (string, error) {
	timestamp := time.Now().Unix()
	filename := fmt.Sprintf("tmp/tts_%d.wav", timestamp)

	// Ensure tmp directory exists
	if err := os.MkdirAll("tmp", 0755); err != nil {
		return "", fmt.Errorf("failed to create tmp directory: %w", err)
	}

	// Step 1: Create audio query using VOICEVOX API
	audioQueryURL := fmt.Sprintf("%s/audio_query?text=%s&speaker=%d", t.apiURL, url.QueryEscape(text), speaker)
	
	// Create POST request for audio_query
	req, err := http.NewRequest("POST", audioQueryURL, nil)
	if err != nil {
		return t.createFallbackAudio(filename, text)
	}
	req.Header.Set("Content-Type", "application/json")
	
	audioQueryResp, err := t.client.Do(req)
	if err != nil {
		return t.createFallbackAudio(filename, text)
	}
	defer audioQueryResp.Body.Close()

	if audioQueryResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(audioQueryResp.Body)
		log.Printf("❌ VOICEVOX audio_query failed (status %d): %s", audioQueryResp.StatusCode, string(body))
		return t.createFallbackAudio(filename, text)
	}

	// Get audio query result (JSON)
	audioQuery, err := io.ReadAll(audioQueryResp.Body)
	if err != nil {
		return t.createFallbackAudio(filename, text)
	}

	log.Printf("✅ VOICEVOX audio_query success: %d bytes", len(audioQuery))

	// Step 2: Generate synthesis using the audio query
	synthURL := fmt.Sprintf("%s/synthesis?speaker=%d", t.apiURL, speaker)
	synthReq, err := http.NewRequest("POST", synthURL, bytes.NewBuffer(audioQuery))
	if err != nil {
		return t.createFallbackAudio(filename, text)
	}

	synthReq.Header.Set("Content-Type", "application/json")

	synthResp, err := t.client.Do(synthReq)
	if err != nil {
		return t.createFallbackAudio(filename, text)
	}
	defer synthResp.Body.Close()

	if synthResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(synthResp.Body)
		log.Printf("❌ VOICEVOX synthesis failed (status %d): %s", synthResp.StatusCode, string(body))
		return t.createFallbackAudio(filename, text)
	}

	// Save WAV audio file
	file, err := os.Create(filename)
	if err != nil {
		return "", fmt.Errorf("failed to create audio file: %w", err)
	}
	defer file.Close()

	if _, err := io.Copy(file, synthResp.Body); err != nil {
		return "", fmt.Errorf("failed to save audio file: %w", err)
	}

	log.Printf("✅ VOICEVOX TTS generated: %s", filename)
	return filename, nil
}

// createFallbackAudio creates a simple beep sound as fallback
func (t *TTSClient) createFallbackAudio(filename, text string) (string, error) {
	// Create a simple 1-second beep using ffmpeg if available
	cmd := exec.Command("ffmpeg", "-f", "lavfi", "-i", "sine=frequency=800:duration=1", "-y", filename)
	if err := cmd.Run(); err != nil {
		// If ffmpeg fails, create an empty WAV file
		return t.createSilentWAV(filename)
	}
	return filename, nil
}

// createSilentWAV creates a basic silent WAV file
func (t *TTSClient) createSilentWAV(filename string) (string, error) {
	// Create a minimal WAV file (1 second of silence at 44100Hz mono)
	wavData := []byte{
		// WAV header (44 bytes)
		0x52, 0x49, 0x46, 0x46, // "RIFF"
		0x24, 0xAC, 0x00, 0x00, // File size - 8
		0x57, 0x41, 0x56, 0x45, // "WAVE"
		0x66, 0x6D, 0x74, 0x20, // "fmt "
		0x10, 0x00, 0x00, 0x00, // Chunk size (16)
		0x01, 0x00, 0x01, 0x00, // Audio format (PCM) + channels (1)
		0x44, 0xAC, 0x00, 0x00, // Sample rate (44100)
		0x88, 0x58, 0x01, 0x00, // Byte rate
		0x02, 0x00, 0x10, 0x00, // Block align + bits per sample
		0x64, 0x61, 0x74, 0x61, // "data"
		0x00, 0xAC, 0x00, 0x00, // Data size
	}
	
	// Add 1 second of silence (44100 samples * 2 bytes)
	silenceData := make([]byte, 44100*2)
	wavData = append(wavData, silenceData...)
	
	err := os.WriteFile(filename, wavData, 0644)
	if err != nil {
		return "", fmt.Errorf("failed to create fallback WAV: %w", err)
	}
	
	return filename, nil
}
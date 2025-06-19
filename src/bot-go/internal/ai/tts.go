package ai

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
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
	// Create TTS request
	req := TTSRequest{
		Text:       text,
		Speaker:    speaker,
		Speed:      1.0,
		Pitch:      0.0,
		Intonation: 1.0,
	}

	jsonData, err := json.Marshal(req)
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	// Send request to AivisSpeech
	httpReq, err := http.NewRequest("POST", t.apiURL+"/audio_query", bytes.NewBuffer(jsonData))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := t.client.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("TTS API error %d: %s", resp.StatusCode, string(body))
	}

	// Get audio query result
	audioQuery, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read audio query: %w", err)
	}

	// Generate synthesis
	synthReq, err := http.NewRequest("POST", fmt.Sprintf("%s/synthesis?speaker=%d", t.apiURL, speaker), bytes.NewBuffer(audioQuery))
	if err != nil {
		return "", fmt.Errorf("failed to create synthesis request: %w", err)
	}

	synthReq.Header.Set("Content-Type", "application/json")

	synthResp, err := t.client.Do(synthReq)
	if err != nil {
		return "", fmt.Errorf("failed to send synthesis request: %w", err)
	}
	defer synthResp.Body.Close()

	if synthResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(synthResp.Body)
		return "", fmt.Errorf("synthesis API error %d: %s", synthResp.StatusCode, string(body))
	}

	// Save audio file
	timestamp := time.Now().Unix()
	filename := fmt.Sprintf("tmp/tts_%d.wav", timestamp)

	// Ensure tmp directory exists
	if err := os.MkdirAll("tmp", 0755); err != nil {
		return "", fmt.Errorf("failed to create tmp directory: %w", err)
	}

	file, err := os.Create(filename)
	if err != nil {
		return "", fmt.Errorf("failed to create audio file: %w", err)
	}
	defer file.Close()

	if _, err := io.Copy(file, synthResp.Body); err != nil {
		return "", fmt.Errorf("failed to save audio file: %w", err)
	}

	return filename, nil
}
package ai

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
)

type WhisperClient struct {
	apiURL string
	client *http.Client
}

type WhisperResponse struct {
	Text string `json:"text"`
}

func NewWhisperClient(apiURL string) *WhisperClient {
	return &WhisperClient{
		apiURL: apiURL,
		client: &http.Client{},
	}
}

func (w *WhisperClient) TranscribeAudio(audioFile string) (string, error) {
	// Open the audio file
	file, err := os.Open(audioFile)
	if err != nil {
		return "", fmt.Errorf("failed to open audio file: %w", err)
	}
	defer file.Close()

	// Create multipart form
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	// Add file field
	part, err := writer.CreateFormFile("file", filepath.Base(audioFile))
	if err != nil {
		return "", fmt.Errorf("failed to create form file: %w", err)
	}

	if _, err := io.Copy(part, file); err != nil {
		return "", fmt.Errorf("failed to copy file: %w", err)
	}

	// Add language field for Japanese
	if err := writer.WriteField("language", "ja"); err != nil {
		return "", fmt.Errorf("failed to write language field: %w", err)
	}

	writer.Close()

	// Create request
	req, err := http.NewRequest("POST", w.apiURL+"/v1/audio/transcriptions", &buf)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", writer.FormDataContentType())

	// Send request
	resp, err := w.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("whisper API error %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var whisperResp WhisperResponse
	if err := json.NewDecoder(resp.Body).Decode(&whisperResp); err != nil {
		return "", fmt.Errorf("failed to decode response: %w", err)
	}

	return whisperResp.Text, nil
}
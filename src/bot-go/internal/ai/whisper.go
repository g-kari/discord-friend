package ai

import (
	"bytes"
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

	// Add audio file field (Faster-Whisper format)
	part, err := writer.CreateFormFile("audio_file", filepath.Base(audioFile))
	if err != nil {
		return "", fmt.Errorf("failed to create form file: %w", err)
	}

	if _, err := io.Copy(part, file); err != nil {
		return "", fmt.Errorf("failed to copy file: %w", err)
	}

	writer.Close()

	// Create request (Faster-Whisper endpoint)
	req, err := http.NewRequest("POST", w.apiURL+"/asr", &buf)
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
		return "", fmt.Errorf("whisper API error %d: %s (URL: %s)", resp.StatusCode, string(body), w.apiURL+"/asr")
	}

	// Read plain text response (Faster-Whisper returns plain text)
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read response: %w", err)
	}

	// Return the transcribed text directly
	return string(body), nil
}
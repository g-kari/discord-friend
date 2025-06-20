package ai

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/gizensya/discord-friend/internal/config"
)

type LLMClient struct {
	config *config.Config
	client *http.Client
}

type OllamaRequest struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Stream bool   `json:"stream"`
}

type OllamaResponse struct {
	Response string `json:"response"`
	Done     bool   `json:"done"`
}

func NewLLMClient(cfg *config.Config) *LLMClient {
	return &LLMClient{
		config: cfg,
		client: &http.Client{},
	}
}

func (l *LLMClient) Generate(prompt string) (string, error) {
	if l.config.PreferLocalLLM {
		return l.generateOllama(prompt)
	}
	return l.generateDify(prompt)
}

func (l *LLMClient) generateOllama(prompt string) (string, error) {
	req := OllamaRequest{
		Model:  "qwen2.5:7b",
		Prompt: prompt,
		Stream: false,
	}

	jsonData, err := json.Marshal(req)
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequest("POST", l.config.OllamaAPIURL+"/api/generate", bytes.NewBuffer(jsonData))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := l.client.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("ollama API error %d: %s", resp.StatusCode, string(body))
	}

	var ollamaResp OllamaResponse
	if err := json.NewDecoder(resp.Body).Decode(&ollamaResp); err != nil {
		return "", fmt.Errorf("failed to decode response: %w", err)
	}

	return ollamaResp.Response, nil
}

func (l *LLMClient) generateDify(prompt string) (string, error) {
	// Placeholder for Dify implementation
	return "Dify response not implemented yet", nil
}
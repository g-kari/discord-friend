package ai

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gizensya/discord-friend/internal/config"
)

// VisionClient handles image analysis using AI
type VisionClient struct {
	config     *config.Config
	client     *http.Client
	ollamaURL  string
	openaiKey  string
}

// VisionRequest represents a request to analyze an image
type VisionRequest struct {
	Model    string         `json:"model"`
	Messages []VisionMessage `json:"messages"`
	Stream   bool           `json:"stream"`
}

// VisionMessage represents a message in the vision request
type VisionMessage struct {
	Role    string        `json:"role"`
	Content []ContentItem `json:"content"`
}

// ContentItem represents content that can be text or image
type ContentItem struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *ImageURL `json:"image_url,omitempty"`
}

// ImageURL represents an image URL or base64 data
type ImageURL struct {
	URL string `json:"url"`
}

// VisionResponse represents the response from vision AI
type VisionResponse struct {
	Response string `json:"response"`
	Done     bool   `json:"done"`
}

// NewVisionClient creates a new vision AI client
func NewVisionClient(cfg *config.Config) *VisionClient {
	return &VisionClient{
		config:    cfg,
		client:    &http.Client{},
		ollamaURL: cfg.OllamaAPIURL,
		openaiKey: os.Getenv("OPENAI_API_KEY"),
	}
}

// AnalyzeImage analyzes an image file and returns a description
func (v *VisionClient) AnalyzeImage(imagePath, prompt string) (string, error) {
	// Try Ollama first (if available), then fallback to simpler description
	if v.ollamaURL != "" {
		result, err := v.analyzeWithOllama(imagePath, prompt)
		if err == nil {
			return result, nil
		}
		fmt.Printf("⚠️ Ollama vision failed, using fallback: %v\n", err)
	}

	// Fallback: basic image info
	return v.getBasicImageInfo(imagePath, prompt)
}

// analyzeWithOllama uses Ollama's vision models (like llava)
func (v *VisionClient) analyzeWithOllama(imagePath, prompt string) (string, error) {
	// Read and encode image
	imageData, err := os.ReadFile(imagePath)
	if err != nil {
		return "", fmt.Errorf("failed to read image: %w", err)
	}

	base64Image := base64.StdEncoding.EncodeToString(imageData)

	// Create vision request
	req := VisionRequest{
		Model: "llava:7b", // Default vision model
		Messages: []VisionMessage{
			{
				Role: "user",
				Content: []ContentItem{
					{
						Type: "text",
						Text: prompt,
					},
					{
						Type: "image_url",
						ImageURL: &ImageURL{
							URL: "data:image/png;base64," + base64Image,
						},
					},
				},
			},
		},
		Stream: false,
	}

	jsonData, err := json.Marshal(req)
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	// Send request to Ollama
	httpReq, err := http.NewRequest("POST", v.ollamaURL+"/api/chat", bytes.NewBuffer(jsonData))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := v.client.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("ollama API error %d: %s", resp.StatusCode, string(body))
	}

	var visionResp VisionResponse
	if err := json.NewDecoder(resp.Body).Decode(&visionResp); err != nil {
		return "", fmt.Errorf("failed to decode response: %w", err)
	}

	return visionResp.Response, nil
}

// getBasicImageInfo provides basic image information as fallback
func (v *VisionClient) getBasicImageInfo(imagePath, prompt string) (string, error) {
	// Get file info
	info, err := os.Stat(imagePath)
	if err != nil {
		return "", fmt.Errorf("failed to get image info: %w", err)
	}

	filename := filepath.Base(imagePath)
	sizeKB := float64(info.Size()) / 1024

	// Read image dimensions (basic check)
	file, err := os.Open(imagePath)
	if err != nil {
		return "", fmt.Errorf("failed to open image: %w", err)
	}
	defer file.Close()

	// Basic image analysis
	description := fmt.Sprintf("📸 スクリーンショットを取得しました\n"+
		"ファイル: %s (%.1f KB)\n"+
		"時刻: %s\n\n"+
		"💡 画像解析機能を使用するには、Ollama LLaVAモデルをインストールしてください:\n"+
		"`ollama pull llava:7b`",
		filename, sizeKB, info.ModTime().Format("2006-01-02 15:04:05"))

	return description, nil
}

// AnalyzeGameScreen analyzes a game screenshot with gaming context
func (v *VisionClient) AnalyzeGameScreen(imagePath string) (string, error) {
	prompt := `これはゲーム画面のスクリーンショットです。以下について分析してください：

🎮 ゲーム内容:
- 何のゲームか（分かる場合）
- 現在の状況や場面
- 画面に表示されている主要な要素

🎯 ゲーム状況:
- プレイヤーの状態（HP、レベル、アイテムなど）
- 現在のミッション/目標
- 注目すべきポイント

💬 友達として:
- ゲーム進行についてのコメント
- アドバイスや提案
- 面白そうな点や気になる点

簡潔で親しみやすい日本語で返答してください。`

	return v.AnalyzeImage(imagePath, prompt)
}

// StartScreenAnalysis starts continuous screen analysis
func (v *VisionClient) StartScreenAnalysis(screenshotChan <-chan string, analysisChan chan<- string) {
	go func() {
		defer close(analysisChan)
		
		for screenshot := range screenshotChan {
			analysis, err := v.AnalyzeGameScreen(screenshot)
			if err != nil {
				fmt.Printf("❌ Screen analysis error: %v\n", err)
				continue
			}
			
			select {
			case analysisChan <- analysis:
				fmt.Printf("🔍 Screen analyzed: %s\n", screenshot)
			default:
				// Channel full, skip this analysis
			}
			
			// Clean up screenshot after analysis
			os.Remove(screenshot)
		}
	}()
}
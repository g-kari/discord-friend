package config

import (
	"os"
	"strconv"
)

type Config struct {
	// Discord
	DiscordBotToken string

	// AI Services
	PreferLocalLLM bool
	OllamaAPIURL   string
	DifyAPIKey     string
	DifyAPIURL     string
	OpenAIAPIKey   string

	// Voice Services
	AivisSpeechAPIURL string
	WhisperAPIURL     string

	// Bot Settings
	DefaultRecordingDuration int
	LogLevel                 string
}

func Load() (*Config, error) {
	cfg := &Config{
		DiscordBotToken:          getEnv("DISCORD_BOT_TOKEN", ""),
		PreferLocalLLM:           getEnvBool("PREFER_LOCAL_LLM", true),
		OllamaAPIURL:             getEnv("OLLAMA_API_URL", "http://localhost:11434"),
		DifyAPIKey:               getEnv("DIFY_API_KEY", ""),
		DifyAPIURL:               getEnv("DIFY_API_URL", ""),
		OpenAIAPIKey:             getEnv("OPENAI_API_KEY", ""),
		AivisSpeechAPIURL:        getEnv("AIVISSPEECH_API_URL", "http://localhost:50021"),
		WhisperAPIURL:            getEnv("WHISPER_API_URL", "http://localhost:8080"),
		DefaultRecordingDuration: getEnvInt("DEFAULT_RECORDING_DURATION", 10),
		LogLevel:                 getEnv("LOG_LEVEL", "INFO"),
	}

	return cfg, nil
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		result, err := strconv.ParseBool(value)
		if err != nil {
			return defaultValue
		}
		return result
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		result, err := strconv.Atoi(value)
		if err != nil {
			return defaultValue
		}
		return result
	}
	return defaultValue
}
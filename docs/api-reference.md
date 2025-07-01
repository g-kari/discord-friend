---
layout: page
title: "API リファレンス"
permalink: /api-reference/
---

# API リファレンス

Discord AI Voice Bot のコマンドとAPI仕様について説明します。

## 🎮 Discord スラッシュコマンド

### 基本コマンド

#### `/ping`
ボットのステータス確認

```
/ping
```

**機能**:
- ボットの応答時間測定
- API接続状態確認
- システムリソース状況表示

**応答例**:
```
🏓 Pong! レスポンス時間: 42ms
✅ すべてのサービス正常
```

---

### 音声関連コマンド

#### `/join`
ボイスチャンネルに参加

```
/join
```

**機能**:
- ユーザーが参加中のボイスチャンネルに自動参加
- Voice Activity Detection (VAD) 自動開始
- 音声処理パイプラインの初期化

**前提条件**:
- ユーザーがボイスチャンネルに参加している
- ボットにVoice権限が付与されている

#### `/leave`
ボイスチャンネルから退出

```
/leave
```

**機能**:
- ボイスチャンネルから退出
- 進行中の録音処理を安全に停止
- リソースのクリーンアップ

#### `/record [duration]`
手動音声録音

```
/record
/record duration:15
```

**パラメータ**:
- `duration` (オプション): 録音時間（秒）、デフォルト10秒、最大30秒

**機能**:
- 指定した時間の音声録音
- 自動音声認識処理
- AI応答生成とTTS再生

#### `/listen`
Voice Activity Detection の開始/停止

```
/listen
```

**機能**:
- VADシステムのON/OFF切り替え
- 自動音声検出の有効化/無効化
- 録音統計情報の表示

**VAD設定**:
- 無音閾値: 1秒
- 最小録音時間: 200ms
- 最大録音時間: 15秒
- 音声検出閾値: パケットサイズ >50バイト

---

### AI・画像解析コマンド

#### `/screenshot`
スクリーンショット撮影・解析

```
/screenshot
```

**機能**:
- デスクトップスクリーンショット撮影
- OpenAI Vision / Ollama LLaVA による画像解析
- 日本語での画像内容説明
- 必要に応じて操作提案

**対応形式**:
- PNG, JPEG形式での画像保存
- 最大解像度: 1920x1080
- ファイルサイズ制限: 10MB

#### `/screen_share`
画面共有解析の開始/停止

```
/screen_share
```

**機能**:
- リアルタイム画面監視の開始/停止
- 定期的なスクリーンショット解析（5秒間隔）
- 画面変化の検出と通知
- 操作支援とアドバイス

---

## 🔧 内部API仕様

### Voice Activity Detection API

#### VAD状態管理

```go
type VADState struct {
    IsActive        bool          `json:"is_active"`
    IsRecording     bool          `json:"is_recording"`
    LastVoiceTime   time.Time     `json:"last_voice_time"`
    RecordingCount  int           `json:"recording_count"`
    TotalDuration   time.Duration `json:"total_duration"`
}
```

#### VAD統計情報

```go
type VADStatistics struct {
    SessionStart     time.Time     `json:"session_start"`
    TotalRecordings  int           `json:"total_recordings"`
    TotalDuration    time.Duration `json:"total_duration"`
    AverageLength    time.Duration `json:"average_length"`
    VoicePackets     int           `json:"voice_packets"`
    SilencePackets   int           `json:"silence_packets"`
}
```

### 音声処理API

#### 音声録音インターフェース

```go
type AudioRecorder interface {
    StartRecording(duration time.Duration) error
    StopRecording() ([]byte, error)
    IsRecording() bool
    GetRecordingDuration() time.Duration
}
```

#### 音声認識API

```go
type WhisperRequest struct {
    AudioData []byte `json:"audio_data"`
    Language  string `json:"language"`
    Model     string `json:"model"`
}

type WhisperResponse struct {
    Text       string  `json:"text"`
    Language   string  `json:"language"`
    Confidence float64 `json:"confidence"`
    Duration   float64 `json:"duration"`
}
```

### AI統合API

#### LLM応答インターフェース

```go
type LLMRequest struct {
    Messages []Message `json:"messages"`
    Model    string    `json:"model"`
    Stream   bool      `json:"stream"`
}

type Message struct {
    Role    string `json:"role"`    // "user", "assistant", "system"
    Content string `json:"content"`
}

type LLMResponse struct {
    Text         string    `json:"text"`
    Model        string    `json:"model"`
    CreatedAt    time.Time `json:"created_at"`
    TokensUsed   int       `json:"tokens_used"`
    ResponseTime float64   `json:"response_time"`
}
```

#### Vision AI API

```go
type VisionRequest struct {
    ImageData []byte `json:"image_data"`
    Prompt    string `json:"prompt"`
    Model     string `json:"model"`
}

type VisionResponse struct {
    Description  string            `json:"description"`
    Objects      []DetectedObject  `json:"objects"`
    Text         []ExtractedText   `json:"text"`
    Confidence   float64           `json:"confidence"`
}

type DetectedObject struct {
    Name       string    `json:"name"`
    Confidence float64   `json:"confidence"`
    BoundingBox Rectangle `json:"bounding_box"`
}
```

### TTS API

#### AivisSpeech (VOICEVOX) インターフェース

```go
type TTSRequest struct {
    Text     string `json:"text"`
    Speaker  int    `json:"speaker"`
    Speed    float64 `json:"speed"`
    Pitch    float64 `json:"pitch"`
}

type TTSResponse struct {
    AudioData []byte  `json:"audio_data"`
    Duration  float64 `json:"duration"`
    Format    string  `json:"format"`
}
```

#### 利用可能な音声タイプ

| Speaker ID | 名前 | 特徴 |
|-----------|------|------|
| 3 | ずんだもん(ノーマル) | 標準的な音声 |
| 1 | 四国めたん(ノーマル) | 落ち着いた音声 |
| 8 | 春日部つむぎ(ノーマル) | 明るい音声 |
| 2 | 四国めたん(あまあま) | 甘い音声 |
| 0 | 四国めたん(ノーマル) | デフォルト |

## 🔌 外部サービス統合

### Ollama API

#### エンドポイント

```
GET  /api/tags              # モデル一覧
POST /api/generate          # テキスト生成
POST /api/chat              # チャット形式
POST /api/pull              # モデルダウンロード
```

#### 推奨モデル

```bash
# 日本語対応LLM
ollama pull qwen2.5:7b       # 軽量・高性能
ollama pull llama3.1:8b      # 汎用性重視
ollama pull codellama:7b     # コード生成特化

# Vision対応
ollama pull llava:7b         # 画像解析
ollama pull llava:13b        # 高精度画像解析
```

### go-whisper API

#### エンドポイント

```
GET  /v1/models             # 利用可能モデル
POST /v1/audio/transcriptions # 音声認識
POST /v1/audio/translations   # 音声翻訳
```

#### 音声認識リクエスト

```bash
curl -X POST http://localhost:8080/v1/audio/transcriptions \
  -H "Content-Type: multipart/form-data" \
  -F "file=@audio.wav" \
  -F "model=whisper-1" \
  -F "language=ja"
```

### VOICEVOX API

#### エンドポイント

```
GET  /speakers              # 利用可能話者
POST /audio_query           # 音声合成クエリ
POST /synthesis            # 音声合成実行
```

#### 音声合成フロー

```bash
# 1. 音声クエリ生成
curl -X POST "http://localhost:50021/audio_query?text=こんにちは&speaker=3"

# 2. 音声合成実行
curl -X POST "http://localhost:50021/synthesis?speaker=3" \
  -H "Content-Type: application/json" \
  -d @query.json \
  --output audio.wav
```

## 📊 ログとメトリクス

### ログレベル

```go
const (
    TRACE = "TRACE"  // 詳細なデバッグ情報
    DEBUG = "DEBUG"  // デバッグ情報
    INFO  = "INFO"   // 一般的な情報
    WARN  = "WARN"   // 警告
    ERROR = "ERROR"  // エラー
)
```

### 主要メトリクス

#### 音声処理メトリクス

```go
type VoiceMetrics struct {
    RecordingsTotal     int           `json:"recordings_total"`
    RecordingDuration   time.Duration `json:"recording_duration"`
    ProcessingTime      time.Duration `json:"processing_time"`
    WhisperLatency      time.Duration `json:"whisper_latency"`
    TTSLatency          time.Duration `json:"tts_latency"`
    ErrorRate           float64       `json:"error_rate"`
}
```

#### システムメトリクス

```go
type SystemMetrics struct {
    Uptime              time.Duration `json:"uptime"`
    MemoryUsage         uint64        `json:"memory_usage"`
    GoroutineCount      int           `json:"goroutine_count"`
    CPUUsage            float64       `json:"cpu_usage"`
    ActiveConnections   int           `json:"active_connections"`
    CommandsProcessed   int           `json:"commands_processed"`
}
```

## 🔐 セキュリティ

### 認証・認可

- Discord OAuth2によるボット認証
- 環境変数による機密情報管理
- チャンネル・ユーザー権限の検証

### レート制限

```go
type RateLimiter struct {
    CommandsPerMinute  int    // スラッシュコマンド: 60回/分
    RecordingsPerHour  int    // 音声録音: 100回/時間
    AIRequestsPerHour  int    // AI API: 500回/時間
    ScreenshotsPerHour int    // スクリーンショット: 20回/時間
}
```

### データ保護

- 音声データの一時保存（処理後自動削除）
- ログの個人情報マスキング
- SSL/TLS通信の強制

## 🚀 パフォーマンス

### 推奨システムリソース

```yaml
Minimum:
  CPU: 2 cores
  RAM: 4GB
  Storage: 5GB

Recommended:
  CPU: 4 cores
  RAM: 8GB  
  Storage: 20GB
  GPU: CUDA対応 (Whisper高速化)
```

### パフォーマンス最適化

- Goroutineによる並行処理
- 音声バッファプーリング
- AIモデルのローカルキャッシュ
- WebSocket接続の維持
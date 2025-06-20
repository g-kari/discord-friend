#!/bin/bash

# Test Whisper server endpoints
echo "🔍 Testing Whisper server on localhost:8080..."

# Find latest recording
AUDIO_FILE=$(ls -t tmp/vad_recording_*.wav 2>/dev/null | head -1)

if [ -z "$AUDIO_FILE" ]; then
    echo "❌ No audio files found in tmp/"
    echo "Please record some audio first using Discord bot"
    exit 1
fi

echo "📁 Testing with: $AUDIO_FILE ($(stat -f%z "$AUDIO_FILE" 2>/dev/null || stat -c%s "$AUDIO_FILE") bytes)"

echo ""
echo "🧪 Testing various endpoints..."

# Test 1: OpenAI-compatible endpoint
echo "1. Testing /v1/audio/transcriptions (OpenAI-compatible):"
curl -X POST \
    -F "file=@$AUDIO_FILE" \
    -F "model=whisper-1" \
    -F "language=ja" \
    http://localhost:8080/api/v1/audio/transcriptions \
    -w "\nStatus: %{http_code}\n" \
    -s | jq . 2>/dev/null || echo "Response not JSON"

echo ""

# Test 2: Simple transcribe endpoint  
echo "2. Testing /transcribe:"
curl -X POST \
    -F "audio=@$AUDIO_FILE" \
    -F "language=ja" \
    http://localhost:8080/api/v1/transcribe \
    -w "\nStatus: %{http_code}\n" \
    -s | jq . 2>/dev/null || echo "Response not JSON"

echo ""

# Test 3: Inference endpoint
echo "3. Testing /inference:"
curl -X POST \
    -F "file=@$AUDIO_FILE" \
    http://localhost:8080/api/v1/inference \
    -w "\nStatus: %{http_code}\n" \
    -s | jq . 2>/dev/null || echo "Response not JSON"

echo ""

# Test 4: Models endpoint
echo "4. Testing /models:"
curl -X GET http://localhost:8080/api/v1/models \
    -w "\nStatus: %{http_code}\n" \
    -s | jq . 2>/dev/null || echo "Response not JSON"

# Test 4: Models endpoint
echo "4. Testing /models:"
curl -X POST http://localhost:8080/api/v1/models?stream=true \
    -w "\nStatus: %{http_code}\n" \
    -d '{"path": "ggml-medium-q5_0.bin"}' \
    -H "Content-Type: application/json" \
    -s | jq . 2>/dev/null || echo "Response not JSON"

echo ""
echo "✅ Test completed"
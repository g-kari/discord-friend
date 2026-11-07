> 旧 Go 版向けの参考情報です。現行の共通音声読み上げサービスでは Ollama を使用しません。現行構成は [README.md](README.md) を参照してください。

# Ollama 実践活用ガイド

Ollamaを使ったローカルLLM環境の構築と最適化のための実践的なヒント集です。

> **📚 関連ドキュメント**: 
> - **[README.md](README.md)** - プロジェクト概要・セットアップ方法
> - **[CLAUDE.md](CLAUDE.md)** - 技術詳細・開発ガイド
> - **[scripts/README.md](scripts/README.md)** - 開発支援ツール

---

## 🚀 Ollamaの利点

### なぜOllamaが優れているのか
- **簡単セットアップ**: ワンコマンドでインストール・起動
- **モデル管理**: `ollama pull/push/list` でDockerライクな管理
- **軽量**: CPUでも動作、GPUがあれば高速化
- **API互換性**: OpenAI API互換で既存ツールと連携しやすい
- **日本語対応**: Qwen2.5など優秀な日本語モデルが利用可能

## 📥 おすすめ日本語モデル

### 1. Qwen2.5シリーズ（最推奨）
```bash
# 軽量・高速版（7B）
ollama pull qwen2.5:7b

# 高品質版（14B） - メモリ16GB以上推奨
ollama pull qwen2.5:14b

# 超軽量版（3B） - 低スペック環境向け
ollama pull qwen2.5:3b
```

### 2. その他の日本語対応モデル
```bash
# Google Gemma 2（日本語も対応）
ollama pull gemma2:9b-instruct-q4_K_M

# Llama 3.1 日本語版
ollama pull llama3.1:8b

# 実験的：日本語特化モデル
ollama pull elyza:8b
```

## ⚡ パフォーマンス最適化

### 1. 環境変数の設定
```bash
# ~/.bashrc または ~/.zshrc に追加

# 同時処理数の調整（デフォルト: 1）
export OLLAMA_NUM_PARALLEL=4

# 最大ロードモデル数（デフォルト: 3）
export OLLAMA_MAX_LOADED_MODELS=2

# CPUスレッド数（デフォルト: 自動）
export OLLAMA_NUM_THREAD=8

# ホストアドレス（外部アクセス許可）
export OLLAMA_HOST=0.0.0.0

# モデル保存先の変更（容量が大きい場合）
export OLLAMA_MODELS=/path/to/large/storage/ollama/models
```

### 2. GPU最適化（NVIDIA GPU使用時）
```bash
# GPU使用状況の確認
nvidia-smi

# CUDA対応の確認
ollama run qwen2.5:7b --verbose

# GPU使用率の調整
export CUDA_VISIBLE_DEVICES=0  # 特定のGPUを使用
```

### 3. メモリ最適化
```bash
# モデル量子化版の使用（メモリ削減）
ollama pull qwen2.5:7b-q4_K_M  # 4bit量子化版
ollama pull qwen2.5:7b-q5_K_M  # 5bit量子化版
ollama pull qwen2.5:7b-q8_0    # 8bit量子化版
```

## 🛠️ 実用的な使い方

### 1. カスタムモデルの作成
```bash
# Modelfileを作成
cat > CustomJapaneseAssistant <<EOF
FROM qwen2.5:7b

# システムプロンプト設定
SYSTEM """
あなたは親切で丁寧な日本語アシスタントです。
ユーザーの質問に対して、分かりやすく適切な日本語で回答してください。
技術的な内容も、初心者にも理解できるように説明することを心がけてください。
"""

# パラメータ調整
PARAMETER temperature 0.7
PARAMETER top_p 0.9
PARAMETER num_predict 2048
PARAMETER repeat_penalty 1.1
EOF

# カスタムモデルを作成
ollama create japanese-assistant -f CustomJapaneseAssistant

# 使用
ollama run japanese-assistant
```

### 2. API経由での利用
```python
# Python例
import requests
import json

def query_ollama(prompt, model="qwen2.5:7b"):
    url = "http://localhost:11434/api/generate"
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False
    }
    
    response = requests.post(url, json=payload)
    return response.json()['response']

# 使用例
result = query_ollama("Pythonの基礎を簡単に説明してください")
print(result)
```

### 3. ストリーミングレスポンス
```python
import requests
import json

def stream_ollama(prompt, model="qwen2.5:7b"):
    url = "http://localhost:11434/api/generate"
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": True
    }
    
    with requests.post(url, json=payload, stream=True) as response:
        for line in response.iter_lines():
            if line:
                chunk = json.loads(line)
                if 'response' in chunk:
                    print(chunk['response'], end='', flush=True)

# 使用例
stream_ollama("日本の四季について詳しく教えてください")
```

## 🔧 便利なコマンド集

### モデル管理
```bash
# インストール済みモデル一覧
ollama list

# モデル詳細情報
ollama show qwen2.5:7b

# モデルのコピー（別名作成）
ollama cp qwen2.5:7b my-japanese-model

# 不要なモデルの削除
ollama rm old-model

# モデルの更新
ollama pull qwen2.5:7b
```

### デバッグ・トラブルシューティング
```bash
# ログの確認
journalctl -u ollama -f  # systemdの場合

# サービス状態確認
systemctl status ollama

# ポート使用確認
lsof -i :11434

# モデルファイルの場所
ls ~/.ollama/models/

# キャッシュクリア
rm -rf ~/.ollama/models/blobs/
```

## 🎯 Discord Botとの統合最適化

> **💡 統合ガイド**: Discord Bot での Ollama 使用方法は [README.md](README.md) と [CLAUDE.md](CLAUDE.md) を参照してください。

### 1. 接続プール設定
```python
# Ollama用の接続プール
import aiohttp
from aiohttp import TCPConnector

# 接続プールの設定
connector = TCPConnector(
    limit=100,              # 総接続数制限
    limit_per_host=30,      # ホストごとの接続数制限
    ttl_dns_cache=300,      # DNSキャッシュ時間
    enable_cleanup_closed=True
)

session = aiohttp.ClientSession(connector=connector)
```

### 2. レスポンス時間最適化
```python
# タイムアウト設定
timeout = aiohttp.ClientTimeout(
    total=30,      # 総タイムアウト
    connect=5,     # 接続タイムアウト
    sock_read=25   # 読み取りタイムアウト
)

# 短い応答用の設定
quick_response_params = {
    "temperature": 0.5,
    "num_predict": 256,
    "top_k": 40,
    "repeat_penalty": 1.2
}
```

### 3. エラーハンドリング
```python
async def safe_ollama_query(prompt, retries=3):
    """安全なOllamaクエリ実行"""
    for attempt in range(retries):
        try:
            response = await query_ollama(prompt)
            return response
        except aiohttp.ClientError as e:
            if attempt == retries - 1:
                raise
            await asyncio.sleep(2 ** attempt)  # 指数バックオフ
```

## 📊 パフォーマンスモニタリング

### 1. 簡易モニタリングスクリプト
```bash
#!/bin/bash
# ollama-monitor.sh

while true; do
    clear
    echo "=== Ollama Status ==="
    echo "Time: $(date)"
    echo ""
    
    # プロセス状態
    echo "Process:"
    ps aux | grep ollama | grep -v grep
    echo ""
    
    # メモリ使用量
    echo "Memory Usage:"
    ps -o pid,vsz,rss,comm -p $(pgrep ollama) 2>/dev/null
    echo ""
    
    # アクティブな接続
    echo "Active Connections:"
    lsof -i :11434 | tail -n +2 | wc -l
    echo ""
    
    # モデル一覧
    echo "Loaded Models:"
    ollama list | tail -n +2
    
    sleep 5
done
```

### 2. Prometheus メトリクス取得
```python
# Ollamaのメトリクスエンドポイント（もし実装されている場合）
import aiohttp
import asyncio

async def get_ollama_metrics():
    async with aiohttp.ClientSession() as session:
        async with session.get('http://localhost:11434/metrics') as resp:
            return await resp.text()
```

## 🐳 Docker Compose統合

### docker-compose.yml
```yaml
version: '3.8'

services:
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama
    environment:
      - OLLAMA_HOST=0.0.0.0
      - OLLAMA_NUM_PARALLEL=4
      - OLLAMA_MAX_LOADED_MODELS=2
    deploy:
      resources:
        limits:
          memory: 16G
        reservations:
          memory: 8G
    restart: unless-stopped
    # GPUサポート（NVIDIA）
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]

  # モデル初期化コンテナ
  ollama-setup:
    image: ollama/ollama:latest
    depends_on:
      - ollama
    volumes:
      - ollama-data:/root/.ollama
    entrypoint: |
      sh -c "
        sleep 10
        ollama pull qwen2.5:7b
        ollama pull qwen2.5:14b
        echo 'Models loaded successfully'
      "

volumes:
  ollama-data:
```

## 🎉 まとめ

Ollamaは以下の点で優れています：

1. **簡単**: 数コマンドで高品質なLLMが使える
2. **軽量**: リソース効率が良く、低スペックでも動作
3. **柔軟**: カスタマイズ可能で様々な用途に対応
4. **統合しやすい**: 標準的なAPIで既存システムと連携

特にQwen2.5シリーズとの組み合わせは、日本語処理において非常に優れた結果を提供します。

Happy Ollama-ing! 🦙
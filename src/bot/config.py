"""
設定と環境変数を管理するモジュール
"""

import json
import os

try:
    import dotenv
except ImportError:
    # Fallback for testing environment without python-dotenv
    import src.bot.dotenv_mock as dotenv

from src.bot.utils.logging_utils import setup_logger

# ロガー設定
logger = setup_logger("config")

# 環境変数のロード
dotenv.load_dotenv()

# Discordボット設定
BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
COMMAND_PREFIX = "!"

# APIキー設定
DIFY_API_KEY = os.getenv("DIFY_API_KEY")
DIFY_API_URL = os.getenv("DIFY_API_URL")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

# TTS設定
AIVISPEECH_API_URL = os.getenv("AIVISSPEECH_API_URL", "http://localhost:50021")

# AIのデフォルトシステムプロンプト
DEFAULT_SYSTEM_PROMPT = os.getenv(
    "DEFAULT_SYSTEM_PROMPT",
    "あなたは親切なAIアシスタントです。質問に簡潔に答えてください。",
)

# データベース設定
DB_PATH = "aiavatar_bot.db"

# 録音設定
MAX_RECORDING_DURATION = 15  # 秒
SILENCE_THRESHOLD = 0.01
SILENCE_DURATION = 1.5
SAMPLE_RATE = 16000

# 自動接続するMCPサーバーとチャンネルの設定
# フォーマット: {"サーバー名": ["チャンネル名1", "チャンネル名2", ...], ...}
# 環境変数から設定を読み込み、なければ空の辞書をデフォルト値とする
MCP_SERVERS = {}
mcp_servers_env = os.getenv("MCP_SERVERS")
if mcp_servers_env:
    try:
        MCP_SERVERS = json.loads(mcp_servers_env)
    except json.JSONDecodeError:
        logger.error(
            "警告: MCP_SERVERSの形式が正しくありません。JSONフォーマットで指定してください。"
        )

# 自動接続するMCPサーバーとチャンネルの設定
# フォーマット: {"サーバー名": ["チャンネル名1", "チャンネル名2", ...], ...}
# 環境変数から設定を読み込み、なければ空の辞書をデフォルト値とする
MCP_SERVERS = {}
mcp_servers_env = os.getenv("MCP_SERVERS")
if mcp_servers_env:
    try:
        MCP_SERVERS = json.loads(mcp_servers_env)
    except json.JSONDecodeError:
        logger.error(
            "警告: MCP_SERVERSの形式が正しくありません。JSONフォーマットで指定してください。"
        )

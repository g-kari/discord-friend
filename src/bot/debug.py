import os
import pathlib
import sys

import dotenv

from src.bot.utils.logging_utils import setup_logger

# ロガー設定
logger = setup_logger("debug")

# 明示的に.envファイルを読み込む
dotenv.load_dotenv()

logger.info("=== デバッグ情報 ===")
logger.info(f"Python バージョン: {sys.version}")
logger.info(f"現在のディレクトリ: {os.getcwd()}")
logger.info(f"ファイルパス: {__file__}")

# 環境変数の確認
logger.info("=== 環境変数 ===")
DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
DIFY_API_KEY = os.getenv("DIFY_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
AIVISSPEECH_API_URL = os.getenv("AIVISSPEECH_API_URL")

logger.info(f"DISCORD_BOT_TOKEN: {'設定済み' if DISCORD_BOT_TOKEN else '未設定'}")
logger.info(f"DIFY_API_KEY: {'設定済み' if DIFY_API_KEY else '未設定'}")
logger.info(f"OPENAI_API_KEY: {'設定済み' if OPENAI_API_KEY else '未設定'}")
logger.info(f"AIVISSPEECH_API_URL: {AIVISSPEECH_API_URL or 'デフォルト(未設定)'}")

# データベースファイルの確認
DB_PATH = str(pathlib.Path.cwd() / "aiavatar_bot.db")
logger.info(f"データベースパス: {DB_PATH}")
logger.info(f"データベースファイルの存在: {os.path.exists(DB_PATH)}")
if os.path.exists(DB_PATH):
    logger.info(f"データベースファイルサイズ: {os.path.getsize(DB_PATH)} バイト")

# 依存パッケージの確認
try:
    import discord

    logger.info("=== 依存パッケージ ===")
    logger.info(f"discord.py バージョン: {discord.__version__}")
except ImportError:
    logger.warning("discord.py がインストールされていません")

try:
    import aiavatar

    logger.info(f"aiavatar バージョン: {aiavatar.__version__}")
except ImportError:
    logger.warning("aiavatar がインストールされていません")
except AttributeError:
    logger.warning("aiavatar はインストールされていますが、バージョン情報が取得できません")

logger.info("デバッグ完了")

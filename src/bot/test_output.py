import os
import sys

from src.bot.utils.logging_utils import setup_logger

# ロガー設定
logger = setup_logger("test_output")

logger.info("This is a test output")
logger.info(f"Python version: {sys.version}")
logger.info(f"Current directory: {os.getcwd()}")
logger.info("Test completed")

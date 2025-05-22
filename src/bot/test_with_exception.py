import sys
import traceback

from src.bot.utils.logging_utils import setup_logger

# ロガー設定
logger = setup_logger("test_with_exception")

try:
    logger.info("Starting test...")
    # 意図的にエラーを発生させる
    1 / 0
except Exception as e:
    error_msg = f"エラーが発生しました: {e}\n{traceback.format_exc()}"
    logger.error(error_msg)
    # ファイルにもエラーを書き出す
    with open("error_log.txt", "w") as f:
        f.write(error_msg)

    sys.exit(1)

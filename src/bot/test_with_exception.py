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
    error_msg = f"エラーが発生しました: {e}"
    logger.error(error_msg)
    # セキュリティ上の理由で、機密情報を含む可能性のある詳細なスタックトレースは
    # ログファイルには書き込まずに、標準エラー出力のみに出力
    print(traceback.format_exc(), file=sys.stderr)

    sys.exit(1)

"""
ロギング機能用のユーティリティモジュール
"""

import logging
import pathlib
from logging.handlers import RotatingFileHandler


def setup_logger(
    name,
    console_level=logging.INFO,
    file_level=logging.DEBUG,
    log_to_file=True,
    log_dir=None,
):
    """
    ロガーの設定を行い、設定済みのロガーを返す

    Args:
        name (str): ロガーの名前
        console_level (int): コンソール出力のログレベル
        file_level (int): ファイル出力のログレベル
        log_to_file (bool): ファイルにログを出力するかどうか
        log_dir (str, optional): ログディレクトリのパス。Noneの場合はカレントディレクトリ/logsが使用される

    Returns:
        logging.Logger: 設定済みのロガーオブジェクト
    """
    # ロガーを取得
    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)  # ロガー自体は全レベルを受け入れる

    # ハンドラが既に設定されていない場合のみ設定する
    if not logger.handlers:
        # コンソールハンドラ
        console_handler = logging.StreamHandler()
        console_handler.setLevel(console_level)
        console_format = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
        console_handler.setFormatter(console_format)
        logger.addHandler(console_handler)

        # ファイルへの出力が有効の場合
        if log_to_file:
            # ログディレクトリの設定
            if log_dir is None:
                log_dir = pathlib.Path.cwd() / "logs"
            else:
                log_dir = pathlib.Path(log_dir)

            # ディレクトリがなければ作成
            log_dir.mkdir(exist_ok=True)

            # ファイルハンドラ（ローテーション機能付き）
            log_file = log_dir / f"{name}.log"
            file_handler = RotatingFileHandler(
                log_file, maxBytes=5 * 1024 * 1024, backupCount=5  # 5MB
            )
            file_handler.setLevel(file_level)
            file_format = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
            file_handler.setFormatter(file_format)
            logger.addHandler(file_handler)

    return logger

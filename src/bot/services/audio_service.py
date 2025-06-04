"""
音声録音と処理に関するモジュール
"""

import logging
import os
import sys
import tempfile

import numpy as np
import soundfile as sf

# 親ディレクトリをインポートパスに追加
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import config after setting path
from src.bot import config  # noqa: E402

# ロギングを設定
logger = logging.getLogger(__name__)

# テスト環境で欠落しているパッケージを処理するため、sounddevice を条件付きでインポート
try:
    import sounddevice as sd

    sounddevice_import_error = None
except ImportError as e:
    logger.warning(f"sounddevice import error: {e}")
    sounddevice_import_error = e
    sd = None


def record_with_silence_detection(
    filename=None,
    max_duration=config.MAX_RECORDING_DURATION,
    silence_threshold=config.SILENCE_THRESHOLD,
    silence_duration=config.SILENCE_DURATION,
    samplerate=config.SAMPLE_RATE,
):
    """
    無音検出付きの音声録音

    Args:
        filename: 保存するファイル名（Noneの場合は一時ファイルを作成）
        max_duration: 最大録音時間（秒）
        silence_threshold: 無音判定の閾値
        silence_duration: 無音判定する時間（秒）
        samplerate: サンプリングレート

    Returns:
        録音ファイルのパス、または録音ができない場合はNone
    """
    # Check if sounddevice is available
    if sd is None:
        logger.error(
            f"sounddeviceがインポートできないため録音できません: {sounddevice_import_error}"
        )
        return None

    # ファイル名が指定されていない場合は一時ファイルを作成
    temp_file = None
    if not filename:
        temp_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        filename = temp_file.name
        temp_file.close()

    try:
        logger.info(f"録音開始... {filename}")
        frames = []
        silence_count = 0
        blocksize = int(samplerate * 0.1)  # 0.1秒ごと
        stream = sd.InputStream(
            samplerate=samplerate, channels=1, dtype="float32", blocksize=blocksize
        )

        with stream:
            for _ in range(int(max_duration / 0.1)):
                data, _ = stream.read(blocksize)
                frames.append(data)
                volume = np.abs(data).mean()
                if volume < silence_threshold:
                    silence_count += 1
                else:
                    silence_count = 0
                if silence_count * 0.1 > silence_duration:
                    break

        audio = np.concatenate(frames, axis=0)
        sf.write(filename, audio, samplerate)
        logger.info(f"録音終了: {filename}")
        return filename

    except Exception as e:
        logger.error(f"録音中にエラーが発生しました: {e}")
        # Clean up the temporary file if recording failed
        if temp_file and os.path.exists(filename):
            try:
                os.remove(filename)
            except Exception:
                pass
        return None


def cleanup_audio_files(files):
    """
    一時音声ファイルを削除

    Args:
        files: 削除するファイルパスのリスト
    """
    if files is None:
        return

    for file in files:
        try:
            if file and os.path.exists(file):
                os.remove(file)
                logger.info(f"削除: {file}")
        except Exception as e:
            logger.error(f"ファイル削除エラー {file}: {e}")

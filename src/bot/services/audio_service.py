"""
音声録音と処理に関するモジュール
"""
import config
import os
import sys
import sounddevice as sd
import numpy as np
import soundfile as sf
import tempfile

# 親ディレクトリをインポートパスに追加
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def record_with_silence_detection(filename=None,
                                  max_duration=config.MAX_RECORDING_DURATION,
                                  silence_threshold=config.SILENCE_THRESHOLD,
                                  silence_duration=config.SILENCE_DURATION,
                                  samplerate=config.SAMPLE_RATE):
    """
    無音検出付きの音声録音

    Args:
        filename: 保存するファイル名（Noneの場合は一時ファイルを作成）
        max_duration: 最大録音時間（秒）
        silence_threshold: 無音判定の閾値
        silence_duration: 無音判定する時間（秒）
        samplerate: サンプリングレート

    Returns:
        録音ファイルのパス
    """
    # ファイル名が指定されていない場合は一時ファイルを作成
    temp_file = None
    if not filename:
        temp_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        filename = temp_file.name
        temp_file.close()

    print(f"録音開始... {filename}")
    frames = []
    silence_count = 0
    blocksize = int(samplerate * 0.1)  # 0.1秒ごと
    stream = sd.InputStream(samplerate=samplerate,
                            channels=1, dtype='float32', blocksize=blocksize)

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
    print(f"録音終了: {filename}")

    return filename


def cleanup_audio_files(files):
    """
    一時音声ファイルを削除

    Args:
        files: 削除するファイルパスのリスト
    """
    for file in files:
        try:
            if os.path.exists(file):
                os.remove(file)
                print(f"削除: {file}")
        except Exception as e:
            print(f"ファイル削除エラー {file}: {e}")

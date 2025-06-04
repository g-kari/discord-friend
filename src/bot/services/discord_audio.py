"""
Discordの音声ストリームを処理するためのモジュール
"""

import asyncio
import logging
import os
import tempfile
import traceback

import discord
import numpy as np
import soundfile as sf

# ロガーの設定
logger = logging.getLogger("aiavatar_bot")


class DiscordAudioSink(discord.AudioSink):  # type: ignore
    """
    Discordの音声ストリームを受信・処理するためのオーディオシンク
    """

    def __init__(self, user_id=None):
        """
        Args:
            user_id: 特定のユーザーの音声のみを録音する場合はそのID
        """
        self.user_audio = {}  # ユーザーごとの音声データ
        self.target_user_id = user_id  # 特定ユーザーのみ録音する場合
        self.recording = True  # 録音状態
        self.last_speaking_time = {}  # 各ユーザーの最後に発話した時刻
        # 録音バッファサイズ制限 (約10秒のオーディオに相当)
        self.max_buffer_size = 500  # Discord音声パケット数の上限
        logger.debug(f"DiscordAudioSink初期化: target_user_id={user_id}")

    def write(self, data, user):
        """
        音声データを受信したときに呼ばれるメソッド

        Args:
            data: PCMオーディオデータ
            user: 音声の送信元ユーザー
        """
        try:
            # ボットや特定ユーザー以外はスキップ
            if user.bot or (self.target_user_id and user.id != self.target_user_id):
                return

            # 録音中でなければスキップ
            if not self.recording:
                return

            # データを保存
            if user.id not in self.user_audio:
                self.user_audio[user.id] = []
                logger.debug(f"ユーザー「{user.name}」の音声データバッファを作成")

            # バッファサイズの制限を確認
            if len(self.user_audio[user.id]) >= self.max_buffer_size:
                # 古いデータを削除して新しいデータを追加
                self.user_audio[user.id] = self.user_audio[user.id][1:] + [data]
                if len(self.user_audio[user.id]) % 100 == 0:  # ログが多すぎないよう制限
                    logger.debug(f"ユーザー「{user.name}」の音声バッファが上限に達したため、古いデータを削除しました")
            else:
                self.user_audio[user.id].append(data)

            self.last_speaking_time[user.id] = asyncio.get_event_loop().time()
        except Exception as e:
            logger.error(f"音声データ処理エラー: {e}")
            logger.debug(traceback.format_exc())

    def get_user_audio(self, user_id):
        """
        特定ユーザーの音声データを取得

        Args:
            user_id: 取得するユーザーID

        Returns:
            PCMオーディオデータのリスト、なければ空リスト
        """
        try:
            return self.user_audio.get(user_id, [])
        except Exception as e:
            logger.error(f"音声データ取得エラー: {e}")
            return []

    def clear_user_audio(self, user_id):
        """
        特定ユーザーの音声データをクリア

        Args:
            user_id: クリアするユーザーID
        """
        try:
            if user_id in self.user_audio:
                self.user_audio[user_id] = []
                logger.debug(f"ユーザーID {user_id} の音声データをクリア")
        except Exception as e:
            logger.error(f"音声データクリアエラー: {e}")

    def get_active_users(self, inactive_threshold=2.0):
        """
        最近発話したアクティブなユーザーのリストを取得

        Args:
            inactive_threshold: 非アクティブと判断する秒数

        Returns:
            アクティブなユーザーIDのリスト
        """
        try:
            current_time = asyncio.get_event_loop().time()
            active_users = []

            for user_id, last_time in self.last_speaking_time.items():
                if current_time - last_time < inactive_threshold:
                    active_users.append(user_id)

            return active_users
        except Exception as e:
            logger.error(f"アクティブユーザー取得エラー: {e}")
            return []

    def cleanup(self):
        """全てのバッファをクリア"""
        try:
            self.user_audio = {}
            self.last_speaking_time = {}
            self.recording = False
            logger.debug("すべての音声データバッファをクリア")
        except Exception as e:
            logger.error(f"音声バッファクリーンアップエラー: {e}")


def save_discord_audio(audio_data, filename=None, samplerate=48000):
    """
    Discordから取得した音声データをWAVファイルに保存

    Args:
        audio_data: PCMオーディオデータのリスト
        filename: 保存するファイル名（Noneの場合は一時ファイルを作成）
        samplerate: サンプリングレート

    Returns:
        保存したファイルのパス、失敗した場合はNone
    """
    try:
        if not audio_data:
            logger.warning("保存する音声データがありません")
            return None

        # ファイル名が指定されていない場合は一時ファイルを作成
        if not filename:
            temp_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            filename = temp_file.name
            temp_file.close()

        # Discordの音声データはint16形式なので、適切に変換
        pcm_data = np.frombuffer(b"".join(audio_data), dtype=np.int16)

        # データが空でないか確認
        if len(pcm_data) == 0:
            logger.warning("変換後の音声データが空です")
            return None

        # 正規化（float32に変換）
        float_data = pcm_data.astype(np.float32) / 32768.0

        # ファイルに保存
        sf.write(filename, float_data, samplerate)

        # ファイルが適切にサイズを持っているか確認
        file_size = os.path.getsize(filename)
        logger.info(
            f"Discord音声を保存: {filename}, サイズ: {file_size} バイト, サンプル数: {len(float_data)}")

        if file_size > 0:
            return filename
        else:
            logger.warning(f"保存したファイルのサイズが0です: {filename}")
            os.remove(filename)
            return None

    except Exception as e:
        logger.error(f"音声ファイル保存エラー: {e}")
        logger.debug(traceback.format_exc())
        # エラー発生時にファイルが作成されていれば削除
        if filename and os.path.exists(filename):
            try:
                os.remove(filename)
            except Exception:
                pass
        return None

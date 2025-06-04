"""
AIAvatarKit連携のサービスモジュール
"""

import asyncio
import logging
import os
import random
import sys

# 親ディレクトリをインポートパスに追加
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# パスを設定後に config をインポート
from src.bot import config

# キャッシュ用：最後に認識したテキスト
last_transcribed = {}

# ロギングを設定
logger = logging.getLogger(__name__)

# テスト用にモック AIAvatar インスタンスを作成するか、実際のものをインポート
aiavatar = None
if "pytest" in sys.modules:
    # テスト環境では AIAvatar をインポートしない
    logger.warning("Running in test environment, using mock AIAvatar")
else:
    try:
        from aiavatar import AIAvatar

        # AIAvatarKitのインスタンスを作成
        try:
            aiavatar = AIAvatar(
                openai_api_key=config.DIFY_API_KEY,
                llm_backend="dify",
                tts_backend="aivisspeech",
                tts_api_url=config.AIVISPEECH_API_URL,
                stt_backend="openai",
            )
        except Exception as e:
            logger.error(f"AIAvatar initialization error: {e}")
            # Set to None in test environment
            if "pytest" in sys.modules:
                aiavatar = None
            else:
                raise
    except ImportError:
        logger.error("AIAvatar package not available")
        aiavatar = None


async def transcribe_audio(audio_file_path):
    """
    音声ファイルをテキストに変換

    Args:
        audio_file_path: 音声ファイルのパス

    Returns:
        認識されたテキスト
    """
    try:
        if aiavatar is None:
            logger.warning("AIAvatar instance is None, returning empty string")
            return ""

        with open(audio_file_path, "rb") as f:
            audio_bytes = f.read()
        text = await aiavatar.stt.transcribe(audio_bytes)
        return text
    except Exception as e:
        print(f"音声認識エラー: {e}")
        return ""


async def get_ai_response(text, history=None, system_prompt=None, channel=None):
    """
    AIアシスタントからの応答を取得

    Args:
        text: ユーザーの入力テキスト
        history: 会話履歴（なければNone）
        system_prompt: システムプロンプト（なければNone）
        channel: オプションのDiscordチャンネル（会話クッションを送信する場合）

    Returns:
        AI応答のテキスト
    """
    # 会話クッション用のタスクとキャンセルイベント
    cushion_task = None
    cancel_event = None

    try:
        if aiavatar is None:
            logger.warning("AIAvatar instance is None, returning mock response")
            return "これはテスト環境のためのモック応答です。"

        # チャンネルが指定されていれば会話クッションを送信開始
        if channel:
            cushion_task, cancel_event = await create_cushion_task(channel)

        # LLM APIを呼び出し
        response = await aiavatar.llm.chat(
            text, history=history or [], system_prompt=system_prompt
        )
        return response
    except Exception as e:
        print(f"AI応答エラー: {e}")
        return "すみません、応答の生成中にエラーが発生しました。"
    finally:
        # クッション送信を終了
        if cancel_event:
            cancel_event.set()
        # タスクが完了するのを待機
        if cushion_task:
            await cushion_task


async def text_to_speech(text):
    """
    テキストを音声に変換

    Args:
        text: 変換するテキスト

    Returns:
        音声データのバイト列
    """
    try:
        if aiavatar is None:
            logger.warning("AIAvatar instance is None, returning None")
            return None

        tts_audio = await aiavatar.tts.speak(text)
        return tts_audio
    except Exception as e:
        print(f"TTS生成エラー: {e}")
        return None


async def create_cushion_task(channel):
    """
    会話クッション送信用のタスクを作成

    Args:
        channel: 送信先のDiscordチャンネル

    Returns:
        (asyncio.Task, asyncio.Event): タスクとキャンセルイベントのタプル
    """
    cancel_event = asyncio.Event()

    async def cushion_sender():
        sent_messages = []
        try:
            # キャンセルされるまでクッションを定期的に送信
            while not cancel_event.is_set():
                try:
                    cushion = get_random_conversation_cushion()
                    message = await channel.send(cushion)
                    sent_messages.append(message)
                    # インターバルを待つが、その間にキャンセルされた場合はすぐに終了
                    try:
                        await asyncio.wait_for(cancel_event.wait(), timeout=3.0)
                    except asyncio.TimeoutError:
                        # タイムアウトは通常の動作なのでパス
                        pass
                except Exception as e:
                    logger.error(f"会話クッション送信エラー: {e}")
                    await asyncio.sleep(2.0)  # エラー時も少し待機
        finally:
            return sent_messages

    # クッション送信タスクを作成して返す
    task = asyncio.create_task(cushion_sender())
    return task, cancel_event


def save_transcribed_text(user_id, text):
    """
    ユーザーIDに関連付けて認識テキストを保存

    Args:
        user_id: ユーザーID
        text: テキスト
    """
    last_transcribed[user_id] = text


def check_keyword_match(text, keyword):
    """
    テキストにキーワードが含まれているか確認

    Args:
        text: 検索対象テキスト
        keyword: 検索キーワード（None可）

    Returns:
        キーワードが含まれていればTrue、なければFalse
        keywordがNoneの場合はTrue
        keywordが空文字列の場合はFalse
    """
    if keyword is None:
        return True
    if keyword == "":
        return False
    return keyword.lower() in text.lower()


def get_random_conversation_cushion():
    """
    ランダムな会話のクッション（フィラーワード）を生成

    Returns:
        ランダムな日本語のフィラーワード
    """
    cushions = [
        "あー",
        "えー",
        "うーん",
        "そうですね",
        "えーと",
        "んー",
        "ちょっと待ってください",
        "考え中です",
        "少々お待ちください",
    ]
    return random.choice(cushions)


async def send_conversation_cushions(channel, interval=2.0, max_cushions=3):
    """
    会話のクッションを定期的に送信する非同期関数

    Args:
        channel: 送信先のDiscordチャンネル
        interval: クッション送信の間隔（秒）
        max_cushions: 最大送信回数（デフォルト3回まで）

    Returns:
        送信したクッションのメッセージのリスト
    """
    sent_messages = []

    # 最大回数までクッションを送信
    for i in range(max_cushions):
        try:
            cushion = get_random_conversation_cushion()
            message = await channel.send(cushion)
            sent_messages.append(message)
            await asyncio.sleep(interval)
        except Exception as e:
            logger.error(f"会話クッション送信エラー: {e}")
            break

    return sent_messages

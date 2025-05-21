"""
AIAvatarKit連携のサービスモジュール
"""
import config
import os
import sys
from aiavatar import AIAvatar

# 親ディレクトリをインポートパスに追加
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# キャッシュ用：最後に認識したテキスト
last_transcribed = {}

# AIAvatarKitのインスタンスを作成
aiavatar = AIAvatar(
    openai_api_key=config.DIFY_API_KEY,
    llm_backend="dify",
    tts_backend="aivisspeech",
    tts_api_url=config.AIVISPEECH_API_URL,
    stt_backend="openai",
)


async def transcribe_audio(audio_file_path):
    """
    音声ファイルをテキストに変換

    Args:
        audio_file_path: 音声ファイルのパス

    Returns:
        認識されたテキスト
    """
    try:
        with open(audio_file_path, "rb") as f:
            audio_bytes = f.read()
        text = await aiavatar.stt.transcribe(audio_bytes)
        return text
    except Exception as e:
        print(f"音声認識エラー: {e}")
        return ""


async def get_ai_response(text, history=None, system_prompt=None):
    """
    AIアシスタントからの応答を取得

    Args:
        text: ユーザーの入力テキスト
        history: 会話履歴（なければNone）
        system_prompt: システムプロンプト（なければNone）

    Returns:
        AI応答のテキスト
    """
    try:
        response = await aiavatar.llm.chat(
            text,
            history=history or [],
            system_prompt=system_prompt
        )
        return response
    except Exception as e:
        print(f"AI応答エラー: {e}")
        return "すみません、応答の生成中にエラーが発生しました。"


async def text_to_speech(text):
    """
    テキストを音声に変換

    Args:
        text: 変換するテキスト

    Returns:
        音声データのバイト列
    """
    try:
        tts_audio = await aiavatar.tts.speak(text)
        return tts_audio
    except Exception as e:
        print(f"TTS生成エラー: {e}")
        return None


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
    """
    if not keyword:
        return True
    return keyword.lower() in text.lower()

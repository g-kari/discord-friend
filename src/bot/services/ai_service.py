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

# Import config after setting path
from src.bot import config  # noqa: E402

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
    音声ファイルをテキストに変換し、感情分析を行う

    Args:
        audio_file_path: 音声ファイルのパス

    Returns:
        dict: 認識されたテキストと感情分析結果
            {
                'text': str,          # 認識されたテキスト
                'emotion': dict       # 感情分析結果
            }
    """
    try:
        if aiavatar is None:
            logger.warning("AIAvatar instance is None, returning empty string")
            return {"text": "", "emotion": _get_default_emotion()}

        with open(audio_file_path, "rb") as f:
            audio_bytes = f.read()
        text = await aiavatar.stt.transcribe(audio_bytes)

        # 入力テキストの感情分析
        emotion = analyze_emotion(text)

        logger.info(f"音声認識結果: {text}")
        logger.info(f"感情分析結果: {format_emotion_result(emotion)}")

        return {"text": text, "emotion": emotion}
    except Exception as e:
        print(f"音声認識エラー: {e}")
        return {"text": "", "emotion": _get_default_emotion()}


async def get_ai_response(text, history=None, system_prompt=None, channel=None):
    """
    AIアシスタントからの応答を取得し、感情分析を行う

    Args:
        text: ユーザーの入力テキスト
        history: 会話履歴（なければNone）
        system_prompt: システムプロンプト（なければNone）
        channel: オプションのDiscordチャンネル（会話クッションを送信する場合）

    Returns:
        dict: AI応答のテキストと感情分析結果
            {
                'text': str,          # AI応答テキスト
                'emotion': dict       # 感情分析結果
            }
    """
    # 会話クッション用のタスクとキャンセルイベント
    cushion_task = None
    cancel_event = None

    try:
        if aiavatar is None:
            logger.warning("AIAvatar instance is None, returning mock response")
            mock_response = "これはテスト環境のためのモック応答です。"
            return {"text": mock_response, "emotion": analyze_emotion(mock_response)}

        # チャンネルが指定されていれば会話クッションを送信開始
        if channel:
            cushion_task, cancel_event = await create_cushion_task(channel)

        # LLM APIを呼び出し
        response = await aiavatar.llm.chat(text, history=history or [], system_prompt=system_prompt)

        # 出力テキストの感情分析
        emotion = analyze_emotion(response)

        logger.info(f"AI応答: {response}")
        logger.info(f"AI応答の感情分析結果: {format_emotion_result(emotion)}")

        return {"text": response, "emotion": emotion}
    except Exception as e:
        print(f"AI応答エラー: {e}")
        error_response = "すみません、応答の生成中にエラーが発生しました。"
        return {"text": error_response, "emotion": analyze_emotion(error_response)}
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


# 感情分析関連の関数


def analyze_emotion(text):
    """
    日本語テキストから感情値を分析する

    Args:
        text (str): 分析対象のテキスト

    Returns:
        dict: 感情値の辞書
            {
                'joy': float,     # 喜び (0.0-1.0)
                'sadness': float, # 悲しみ (0.0-1.0)
                'anger': float,   # 怒り (0.0-1.0)
                'fear': float,    # 恐れ (0.0-1.0)
                'surprise': float,# 驚き (0.0-1.0)
                'disgust': float, # 嫌悪 (0.0-1.0)
                'neutral': float, # 中性 (0.0-1.0)
                'dominant_emotion': str  # 最も強い感情
            }
    """
    if not text or not text.strip():
        return _get_default_emotion()

    text = text.lower()

    # 感情ごとの日本語キーワード辞書
    emotion_keywords = {
        "joy": [
            "うれしい",
            "嬉しい",
            "楽しい",
            "たのしい",
            "幸せ",
            "しあわせ",
            "よかった",
            "最高",
            "すばらしい",
            "素晴らしい",
            "いいね",
            "わーい",
            "やったー",
            "ありがとう",
            "感謝",
            "ラッキー",
            "よい",
            "良い",
            "笑",
            "w",
            "wwww",
            "にこにこ",
            "わくわく",
            "興奮",
            "ハッピー",
            "喜び",
            "きもちいい",
            "気持ちいい",
        ],
        "sadness": [
            "悲しい",
            "かなしい",
            "つらい",
            "辛い",
            "寂しい",
            "さみしい",
            "落ち込む",
            "泣く",
            "涙",
            "絶望",
            "むなしい",
            "空しい",
            "しょんぼり",
            "がっかり",
            "残念",
            "失望",
            "しんどい",
            "めんどう",
            "面倒",
            "落ち込んで",
            "寂しくて",
        ],
        "anger": [
            "怒り",
            "腹立つ",
            "むかつく",
            "イライラ",
            "いらいら",
            "頭にくる",
            "ふざけるな",
            "ばかやろう",
            "うざい",
            "ウザい",
            "きらい",
            "嫌い",
            "やめろ",
            "だまれ",
            "黙れ",
            "くそ",
            "クソ",
            "しね",
            "死ね",
            "許せない",
            "腹が立つ",
            "腹が立って",
            "気に入らない",
            "いい加減にしろ",
        ],
        "fear": [
            "怖い",
            "こわい",
            "不安",
            "ふあん",
            "恐怖",
            "緊張",
            "きんちょう",
            "ドキドキ",
            "どきどき",
            "ショック",
            "やばい",
            "ヤバい",
            "危険",
            "あぶない",
            "危ない",
            "ピンチ",
            "心配",
            "しんぱい",
            "おそろしい",
            "恐ろしい",
            "びくびく",
            "がたがた",
            "ぞっと",
        ],
        "surprise": [
            "驚き",
            "おどろき",
            "びっくり",
            "ビックリ",
            "意外",
            "いがい",
            "まさか",
            "えー",
            "ええー",
            "うそー",
            "嘘",
            "なんと",
            "すごい",
            "すげー",
            "マジで",
            "まじで",
            "本当",
            "ほんとう",
            "ほんと",
            "えーっ",
            "わー",
            "おー",
            "へー",
            "あー",
            "なるほど",
        ],
        "disgust": [
            "きもい",
            "気持ち悪い",
            "きしょい",
            "嫌",
            "いや",
            "やだ",
            "イヤ",
            "最悪",
            "汚い",
            "きたない",
            "嫌悪",
            "げー",
            "うげー",
            "オエー",
            "やめて",
            "とまって",
            "止まって",
            "汚くて",
        ],
    }

    # 各感情のスコアを計算
    emotion_scores = {}

    for emotion, keywords in emotion_keywords.items():
        score = 0
        for keyword in keywords:
            # キーワードがテキストに含まれている回数をカウント
            if keyword in text:
                # キーワードの長さに応じて重み付け（長いキーワードの方が信頼性が高い）
                weight = len(keyword) / 10.0 + 1.0
                score += weight
        emotion_scores[emotion] = score

    # 合計スコアを計算
    total_score = sum(emotion_scores.values())

    # 正規化（0.0-1.0）
    if total_score > 0:
        for emotion in emotion_scores:
            emotion_scores[emotion] = emotion_scores[emotion] / total_score
    else:
        # キーワードが見つからない場合は中性
        emotion_scores = {emotion: 0.0 for emotion in emotion_keywords.keys()}

    # 中性の計算（他の感情の合計が少ない場合は中性が高い）
    other_emotions_sum = sum(emotion_scores.values())
    neutral_score = max(0.0, 1.0 - other_emotions_sum) if other_emotions_sum > 0 else 1.0

    # 最終的な感情辞書を作成
    result = {
        "joy": emotion_scores.get("joy", 0.0),
        "sadness": emotion_scores.get("sadness", 0.0),
        "anger": emotion_scores.get("anger", 0.0),
        "fear": emotion_scores.get("fear", 0.0),
        "surprise": emotion_scores.get("surprise", 0.0),
        "disgust": emotion_scores.get("disgust", 0.0),
        "neutral": neutral_score,
    }

    # 最も強い感情を特定
    dominant_emotion = max(result.keys(), key=lambda k: result[k])
    result["dominant_emotion"] = dominant_emotion

    return result


def _get_default_emotion():
    """
    デフォルトの感情値（中性）を返す

    Returns:
        dict: デフォルトの感情値
    """
    return {
        "joy": 0.0,
        "sadness": 0.0,
        "anger": 0.0,
        "fear": 0.0,
        "surprise": 0.0,
        "disgust": 0.0,
        "neutral": 1.0,
        "dominant_emotion": "neutral",
    }


def get_emotion_intensity(emotion_data):
    """
    感情データから感情の強度を計算する

    Args:
        emotion_data (dict): analyze_emotion()の戻り値

    Returns:
        float: 感情の強度 (0.0-1.0)、中性の場合は0.0
    """
    if not emotion_data or emotion_data.get("dominant_emotion") == "neutral":
        return 0.0

    dominant_emotion = emotion_data.get("dominant_emotion", "neutral")
    if dominant_emotion == "neutral":
        return 0.0

    return emotion_data.get(dominant_emotion, 0.0)


def format_emotion_result(emotion_data):
    """
    感情分析結果を読みやすい形式でフォーマットする

    Args:
        emotion_data (dict): analyze_emotion()の戻り値

    Returns:
        str: フォーマットされた感情分析結果
    """
    if not emotion_data:
        return "感情分析データがありません"

    dominant = emotion_data.get("dominant_emotion", "neutral")
    intensity = get_emotion_intensity(emotion_data)

    emotion_names = {
        "joy": "喜び",
        "sadness": "悲しみ",
        "anger": "怒り",
        "fear": "恐れ",
        "surprise": "驚き",
        "disgust": "嫌悪",
        "neutral": "中性",
    }

    dominant_name = emotion_names.get(dominant, "不明")

    if intensity > 0.7:
        intensity_text = "強い"
    elif intensity > 0.4:
        intensity_text = "中程度の"
    elif intensity > 0.1:
        intensity_text = "弱い"
    else:
        intensity_text = ""

    if dominant == "neutral":
        return f"感情: {dominant_name}"
    else:
        return f"感情: {intensity_text}{dominant_name} (強度: {intensity:.2f})"


# 後方互換性のための関数


async def transcribe_audio_legacy(audio_file_path):
    """
    後方互換性のための音声認識関数（テキストのみ返す）

    Args:
        audio_file_path: 音声ファイルのパス

    Returns:
        str: 認識されたテキスト
    """
    result = await transcribe_audio(audio_file_path)
    return result["text"]


async def get_ai_response_legacy(text, history=None, system_prompt=None, channel=None):
    """
    後方互換性のためのAI応答関数（テキストのみ返す）

    Args:
        text: ユーザーの入力テキスト
        history: 会話履歴
        system_prompt: システムプロンプト
        channel: Discordチャンネル

    Returns:
        str: AI応答テキスト
    """
    result = await get_ai_response(text, history, system_prompt, channel)
    return result["text"]

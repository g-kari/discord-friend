"""
感情分析機能のテスト
"""

import unittest

from src.bot.services.ai_service import (
    analyze_emotion,
    format_emotion_result,
    get_emotion_intensity,
    _get_default_emotion,
)


class TestEmotionAnalysis(unittest.TestCase):
    """感情分析機能のテストクラス"""

    def test_analyze_emotion_joy(self):
        """喜びの感情が正しく分析されるかテスト"""
        test_texts = [
            "今日はとても嬉しいです！",
            "楽しい一日でした。ありがとう！",
            "最高の気分です！やったー！",
            "幸せな気持ちです。良い日だった。",
        ]

        for text in test_texts:
            result = analyze_emotion(text)
            self.assertIsInstance(result, dict)
            self.assertIn("joy", result)
            self.assertIn("dominant_emotion", result)
            self.assertEqual(result["dominant_emotion"], "joy")
            self.assertGreater(result["joy"], 0.0)

    def test_analyze_emotion_sadness(self):
        """悲しみの感情が正しく分析されるかテスト"""
        test_texts = [
            "今日は悲しい出来事がありました",
            "つらい気持ちです。泣きたい",
            "落ち込んでいます。残念です",
            "寂しくて仕方ない",
        ]

        for text in test_texts:
            result = analyze_emotion(text)
            self.assertIsInstance(result, dict)
            self.assertIn("sadness", result)
            self.assertIn("dominant_emotion", result)
            self.assertEqual(result["dominant_emotion"], "sadness")
            self.assertGreater(result["sadness"], 0.0)

    def test_analyze_emotion_anger(self):
        """怒りの感情が正しく分析されるかテスト"""
        test_texts = [
            "本当にむかつく！",
            "腹が立って仕方ない",
            "イライラする状況です",
            "許せない行為だ",
        ]

        for text in test_texts:
            result = analyze_emotion(text)
            self.assertIsInstance(result, dict)
            self.assertIn("anger", result)
            self.assertIn("dominant_emotion", result)
            self.assertEqual(result["dominant_emotion"], "anger")
            self.assertGreater(result["anger"], 0.0)

    def test_analyze_emotion_fear(self):
        """恐れの感情が正しく分析されるかテスト"""
        test_texts = [
            "とても怖い体験でした",
            "不安で眠れません",
            "危険な状況です",
            "心配で仕方ない",
        ]

        for text in test_texts:
            result = analyze_emotion(text)
            self.assertIsInstance(result, dict)
            self.assertIn("fear", result)
            self.assertIn("dominant_emotion", result)
            self.assertEqual(result["dominant_emotion"], "fear")
            self.assertGreater(result["fear"], 0.0)

    def test_analyze_emotion_surprise(self):
        """驚きの感情が正しく分析されるかテスト"""
        test_texts = [
            "びっくりしました！",
            "意外な結果でした",
            "まさかこんなことが！",
            "本当に驚きです",
        ]

        for text in test_texts:
            result = analyze_emotion(text)
            self.assertIsInstance(result, dict)
            self.assertIn("surprise", result)
            self.assertIn("dominant_emotion", result)
            self.assertEqual(result["dominant_emotion"], "surprise")
            self.assertGreater(result["surprise"], 0.0)

    def test_analyze_emotion_disgust(self):
        """嫌悪の感情が正しく分析されるかテスト"""
        test_texts = [
            "気持ち悪い光景でした",
            "嫌な思いをしました",
            "最悪の状況です",
            "汚くて見ていられない",
        ]

        for text in test_texts:
            result = analyze_emotion(text)
            self.assertIsInstance(result, dict)
            self.assertIn("disgust", result)
            self.assertIn("dominant_emotion", result)
            self.assertEqual(result["dominant_emotion"], "disgust")
            self.assertGreater(result["disgust"], 0.0)

    def test_analyze_emotion_neutral(self):
        """中性の感情が正しく分析されるかテスト"""
        test_texts = [
            "今日は普通の一日でした",
            "特に何もありませんでした",
            "平凡な出来事です",
            "いつも通りの状況です",
        ]

        for text in test_texts:
            result = analyze_emotion(text)
            self.assertIsInstance(result, dict)
            self.assertIn("neutral", result)
            self.assertIn("dominant_emotion", result)
            self.assertEqual(result["dominant_emotion"], "neutral")
            self.assertGreater(result["neutral"], 0.0)

    def test_analyze_emotion_empty_text(self):
        """空のテキストの処理をテスト"""
        result = analyze_emotion("")
        self.assertEqual(result["dominant_emotion"], "neutral")
        self.assertEqual(result["neutral"], 1.0)

        result = analyze_emotion(None)
        self.assertEqual(result["dominant_emotion"], "neutral")
        self.assertEqual(result["neutral"], 1.0)

        result = analyze_emotion("   ")
        self.assertEqual(result["dominant_emotion"], "neutral")
        self.assertEqual(result["neutral"], 1.0)

    def test_emotion_result_structure(self):
        """感情分析結果の構造をテスト"""
        result = analyze_emotion("楽しい気分です")

        # 必要なキーが存在することを確認
        required_keys = [
            "joy",
            "sadness",
            "anger",
            "fear",
            "surprise",
            "disgust",
            "neutral",
            "dominant_emotion",
        ]
        for key in required_keys:
            self.assertIn(key, result)

        # 数値型の値が正しい範囲にあることを確認
        for emotion in required_keys[:-1]:  # dominant_emotionを除く
            self.assertIsInstance(result[emotion], float)
            self.assertGreaterEqual(result[emotion], 0.0)
            self.assertLessEqual(result[emotion], 1.0)

        # dominant_emotionが文字列であることを確認
        self.assertIsInstance(result["dominant_emotion"], str)

    def test_get_default_emotion(self):
        """デフォルト感情値をテスト"""
        result = _get_default_emotion()

        self.assertEqual(result["joy"], 0.0)
        self.assertEqual(result["sadness"], 0.0)
        self.assertEqual(result["anger"], 0.0)
        self.assertEqual(result["fear"], 0.0)
        self.assertEqual(result["surprise"], 0.0)
        self.assertEqual(result["disgust"], 0.0)
        self.assertEqual(result["neutral"], 1.0)
        self.assertEqual(result["dominant_emotion"], "neutral")

    def test_get_emotion_intensity(self):
        """感情強度の計算をテスト"""
        # 強い喜びの感情
        joy_emotion = {
            "joy": 0.8,
            "sadness": 0.0,
            "anger": 0.0,
            "fear": 0.0,
            "surprise": 0.0,
            "disgust": 0.0,
            "neutral": 0.2,
            "dominant_emotion": "joy",
        }
        intensity = get_emotion_intensity(joy_emotion)
        self.assertEqual(intensity, 0.8)

        # 中性の感情
        neutral_emotion = _get_default_emotion()
        intensity = get_emotion_intensity(neutral_emotion)
        self.assertEqual(intensity, 0.0)

        # 空のデータ
        intensity = get_emotion_intensity({})
        self.assertEqual(intensity, 0.0)

        # Noneデータ
        intensity = get_emotion_intensity(None)
        self.assertEqual(intensity, 0.0)

    def test_format_emotion_result(self):
        """感情結果のフォーマット機能をテスト"""
        # 強い喜びの感情
        joy_emotion = {
            "joy": 0.8,
            "sadness": 0.0,
            "anger": 0.0,
            "fear": 0.0,
            "surprise": 0.0,
            "disgust": 0.0,
            "neutral": 0.2,
            "dominant_emotion": "joy",
        }
        result = format_emotion_result(joy_emotion)
        self.assertIsInstance(result, str)
        self.assertIn("喜び", result)
        self.assertIn("強い", result)

        # 中性の感情
        neutral_emotion = _get_default_emotion()
        result = format_emotion_result(neutral_emotion)
        self.assertIsInstance(result, str)
        self.assertIn("中性", result)

        # 空のデータ
        result = format_emotion_result({})
        self.assertIn("感情分析データがありません", result)

        # Noneデータ
        result = format_emotion_result(None)
        self.assertIn("感情分析データがありません", result)

    def test_mixed_emotions(self):
        """複数の感情が混在するテキストをテスト"""
        mixed_text = "嬉しいけれど少し不安もあります"
        result = analyze_emotion(mixed_text)

        # 喜びと恐れの両方が検出されることを確認
        self.assertGreater(result["joy"], 0.0)
        self.assertGreater(result["fear"], 0.0)

        # dominant_emotionが設定されていることを確認
        self.assertIn(result["dominant_emotion"], ["joy", "fear"])

    def test_case_insensitive(self):
        """大文字小文字を無視した分析をテスト"""
        text1 = "うれしい"

        result1 = analyze_emotion(text1)

        # すべて喜びが検出されることを確認
        self.assertEqual(result1["dominant_emotion"], "joy")


if __name__ == "__main__":
    unittest.main()

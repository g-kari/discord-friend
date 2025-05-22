import asyncio
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

# Assuming ai_service.py is in src.bot.services
from src.bot.services.ai_service import (
    check_keyword_match,
    get_ai_response,
    text_to_speech,
    transcribe_audio,
)


class TestAIService(unittest.TestCase):

    def setUp(self):
        self.mock_aiavatar = MagicMock()
        # Mock the methods that would be called on AIAvatar's components
        self.mock_aiavatar.stt.transcribe = AsyncMock(
            return_value="This is a test transcription."
        )
        self.mock_aiavatar.llm.chat = AsyncMock(
            return_value="This is a test AI response."
        )
        self.mock_aiavatar.tts.speak = AsyncMock(return_value=b"dummy_speech_output")

    @patch("src.bot.services.ai_service.aiavatar")
    def test_transcribe_audio_success(self, mock_aiavatar):
        mock_aiavatar.stt.transcribe = AsyncMock(return_value="Test transcription")

        dummy_audio_path = "dummy_audio.wav"
        # Mocking the file open operation
        m = unittest.mock.mock_open(read_data=b"dummy audio data")

        with patch("builtins.open", m):
            result = asyncio.run(transcribe_audio(dummy_audio_path))

        # Assert that transcribe was called with binary data
        mock_aiavatar.stt.transcribe.assert_called_once()
        self.assertEqual(result, "Test transcription")

    @patch("src.bot.services.ai_service.aiavatar")
    def test_transcribe_audio_failure(self, mock_aiavatar):
        mock_aiavatar.stt.transcribe = AsyncMock(side_effect=Exception("STT Error"))

        dummy_audio_path = "dummy_audio.wav"
        # Mocking the file open operation
        m = unittest.mock.mock_open(read_data=b"dummy audio data")

        with patch("builtins.open", m):
            result = asyncio.run(transcribe_audio(dummy_audio_path))

        # Verify the function returns empty string on error
        self.assertEqual(result, "")

    @patch("src.bot.services.ai_service.aiavatar")
    def test_get_ai_response_success(self, mock_aiavatar):
        mock_aiavatar.llm.chat = AsyncMock(return_value="AI response")

        text = "Hello AI"
        history = [{"role": "user", "content": "Previous message"}]
        system_prompt = "You are a helpful assistant."

        result = asyncio.run(get_ai_response(text, history, system_prompt))

        mock_aiavatar.llm.chat.assert_called_once()
        self.assertEqual(result, "AI response")

    @patch("src.bot.services.ai_service.aiavatar")
    def test_get_ai_response_failure(self, mock_aiavatar):
        mock_aiavatar.llm.chat = AsyncMock(side_effect=Exception("LLM Error"))

        text = "Hello AI"
        history = []
        system_prompt = "You are a helpful assistant."

        result = asyncio.run(get_ai_response(text, history, system_prompt))

        # Verify the function returns an error message on exception
        self.assertEqual(result, "すみません、応答の生成中にエラーが発生しました。")

    @patch("src.bot.services.ai_service.aiavatar")
    def test_text_to_speech_success(self, mock_aiavatar):
        audio_bytes = b"dummy audio data"
        mock_aiavatar.tts.speak = AsyncMock(return_value=audio_bytes)

        text = "Speak this text."
        result = asyncio.run(text_to_speech(text))

        mock_aiavatar.tts.speak.assert_called_once_with(text)
        self.assertEqual(result, audio_bytes)

    @patch("src.bot.services.ai_service.aiavatar")
    def test_text_to_speech_failure(self, mock_aiavatar):
        mock_aiavatar.tts.speak = AsyncMock(side_effect=Exception("TTS Error"))

        text = "Speak this text."
        result = asyncio.run(text_to_speech(text))

        mock_aiavatar.tts.speak.assert_called_once_with(text)
        self.assertIsNone(result)

    def test_check_keyword_match(self):
        self.assertTrue(
            check_keyword_match("some text", None)
        )  # None keyword should return True
        self.assertTrue(check_keyword_match("Hello world", "world"))
        self.assertTrue(check_keyword_match("Hello WORLD", "world"))  # Case-insensitive
        self.assertFalse(check_keyword_match("Hello world", "test"))
        self.assertFalse(check_keyword_match("", "keyword"))
        self.assertFalse(check_keyword_match("some text", ""))  # Empty keyword
        self.assertFalse(
            check_keyword_match("another example", "exa mple")
        )  # Keyword with space
        self.assertTrue(check_keyword_match("keyword at start", "keyword"))
        self.assertTrue(check_keyword_match("end keyword", "keyword"))
        self.assertTrue(check_keyword_match("this is a KEYWORD in middle", "keyword"))


if __name__ == "__main__":
    unittest.main()

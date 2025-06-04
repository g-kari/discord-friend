import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Assuming ai_service.py is in src.bot.services
from src.bot.services.ai_service import (
    check_keyword_match,
    create_cushion_task,
    get_ai_response,
    get_random_conversation_cushion,
    send_conversation_cushions,
    text_to_speech,
    transcribe_audio,
)


class TestAIService(unittest.TestCase):

    def setUp(self):
        self.mock_aiavatar = MagicMock()
        # Mock the methods that would be called on AIAvatar's components
        self.mock_aiavatar.stt.transcribe = AsyncMock(
            return_value="This is a test transcription.")
        self.mock_aiavatar.llm.chat = AsyncMock(
            return_value="This is a test AI response.")
        self.mock_aiavatar.tts.speak = AsyncMock(return_value=b"dummy_speech_output")

    @pytest.mark.asyncio
    @patch("src.bot.services.ai_service.aiavatar")
    async def test_transcribe_audio_success(self, mock_aiavatar):
        mock_aiavatar.stt.transcribe = AsyncMock(return_value="Test transcription")

        dummy_audio_path = "dummy_audio.wav"
        # Mocking the file open operation
        m = unittest.mock.mock_open(read_data=b"dummy audio data")

        with patch("builtins.open", m):
            result = await transcribe_audio(dummy_audio_path)

        # Assert that transcribe was called with binary data
        mock_aiavatar.stt.transcribe.assert_called_once()
        self.assertEqual(result, "Test transcription")

    @pytest.mark.asyncio
    @patch("src.bot.services.ai_service.aiavatar")
    async def test_transcribe_audio_failure(self, mock_aiavatar):
        mock_aiavatar.stt.transcribe = AsyncMock(side_effect=Exception("STT Error"))

        dummy_audio_path = "dummy_audio.wav"
        # Mocking the file open operation
        m = unittest.mock.mock_open(read_data=b"dummy audio data")

        with patch("builtins.open", m):
            result = await transcribe_audio(dummy_audio_path)

        # Verify the function returns empty string on error
        self.assertEqual(result, "")

    @pytest.mark.asyncio
    @patch("src.bot.services.ai_service.aiavatar")
    @patch("src.bot.services.ai_service.create_cushion_task")
    async def test_get_ai_response_success(self, mock_create_cushion_task,
                                           mock_aiavatar):
        mock_aiavatar.llm.chat = AsyncMock(return_value="AI response")

        # Mock cushion task
        mock_task = AsyncMock()
        mock_cancel_event = MagicMock()
        mock_create_cushion_task.return_value = (mock_task, mock_cancel_event)

        text = "Hello AI"
        history = [{"role": "user", "content": "Previous message"}]
        system_prompt = "You are a helpful assistant."
        mock_channel = MagicMock()

        result = await get_ai_response(text, history, system_prompt, mock_channel)

        # Verify function calls and results
        mock_create_cushion_task.assert_called_once_with(mock_channel)
        mock_aiavatar.llm.chat.assert_called_once()
        mock_cancel_event.set.assert_called_once()
        mock_task.__await__.assert_called()
        self.assertEqual(result, "AI response")

    @pytest.mark.asyncio
    @patch("src.bot.services.ai_service.aiavatar")
    @patch("src.bot.services.ai_service.create_cushion_task")
    async def test_get_ai_response_failure(self, mock_create_cushion_task,
                                           mock_aiavatar):
        mock_aiavatar.llm.chat = AsyncMock(side_effect=Exception("LLM Error"))

        # Mock cushion task
        mock_task = AsyncMock()
        mock_cancel_event = MagicMock()
        mock_create_cushion_task.return_value = (mock_task, mock_cancel_event)

        text = "Hello AI"
        history = []
        system_prompt = "You are a helpful assistant."
        mock_channel = MagicMock()

        result = await get_ai_response(text, history, system_prompt, mock_channel)

        # Verify the function returns an error message on exception
        self.assertEqual(result, "すみません、応答の生成中にエラーが発生しました。")
        # Verify cushion task was cancelled
        mock_cancel_event.set.assert_called_once()
        mock_task.__await__.assert_called()

    @pytest.mark.asyncio
    @patch("src.bot.services.ai_service.aiavatar")
    async def test_text_to_speech_success(self, mock_aiavatar):
        audio_bytes = b"dummy audio data"
        mock_aiavatar.tts.speak = AsyncMock(return_value=audio_bytes)

        text = "Speak this text."
        result = await text_to_speech(text)

        mock_aiavatar.tts.speak.assert_called_once_with(text)
        self.assertEqual(result, audio_bytes)

    @pytest.mark.asyncio
    @patch("src.bot.services.ai_service.aiavatar")
    async def test_text_to_speech_failure(self, mock_aiavatar):
        mock_aiavatar.tts.speak = AsyncMock(side_effect=Exception("TTS Error"))

        text = "Speak this text."
        result = await text_to_speech(text)

        mock_aiavatar.tts.speak.assert_called_once_with(text)
        self.assertIsNone(result)

    def test_check_keyword_match(self):
        self.assertTrue(check_keyword_match("some text",
                                            None))  # None keyword should return True
        self.assertTrue(check_keyword_match("Hello world", "world"))
        self.assertTrue(check_keyword_match("Hello WORLD", "world"))  # Case-insensitive
        self.assertFalse(check_keyword_match("Hello world", "test"))
        self.assertFalse(check_keyword_match("", "keyword"))
        self.assertFalse(check_keyword_match("some text", ""))  # Empty keyword
        self.assertFalse(check_keyword_match("another example",
                                             "exa mple"))  # Keyword with space
        self.assertTrue(check_keyword_match("keyword at start", "keyword"))
        self.assertTrue(check_keyword_match("end keyword", "keyword"))
        self.assertTrue(check_keyword_match("this is a KEYWORD in middle", "keyword"))

    def test_get_random_conversation_cushion(self):
        # Call the function multiple times and check if it returns valid cushions
        for _ in range(10):
            cushion = get_random_conversation_cushion()
            self.assertIsInstance(cushion, str)
            self.assertTrue(len(cushion) > 0)
            # Values should be from our predefined list
            self.assertIn(
                cushion,
                [
                    "あー",
                    "えー",
                    "うーん",
                    "そうですね",
                    "えーと",
                    "んー",
                    "ちょっと待ってください",
                    "考え中です",
                    "少々お待ちください",
                ],
            )

    @pytest.mark.asyncio
    @patch("src.bot.services.ai_service.asyncio.sleep")
    async def test_send_conversation_cushions(self, mock_sleep):
        # Mock asyncio.sleep to speed up testing
        mock_sleep.side_effect = lambda _: asyncio.sleep(0)

        # Create a mock channel
        mock_channel = MagicMock()
        mock_channel.send = AsyncMock()

        # Call our function
        result = await send_conversation_cushions(mock_channel,
                                                  interval=0.1,
                                                  max_cushions=2)

        # Check results
        self.assertEqual(len(result), 2)  # Should have 2 sent messages
        self.assertEqual(mock_channel.send.call_count,
                         2)  # send() should be called twice
        mock_sleep.assert_called()  # sleep should have been called

    @pytest.mark.asyncio
    @patch("src.bot.services.ai_service.asyncio.create_task")
    @patch("src.bot.services.ai_service.asyncio.Event")
    async def test_create_cushion_task(self, mock_event, mock_create_task):
        # Mock the asyncio Event
        mock_event_instance = MagicMock()
        mock_event.return_value = mock_event_instance

        # Mock create_task
        mock_task = MagicMock()
        mock_create_task.return_value = mock_task

        # Mock channel
        mock_channel = MagicMock()

        task, cancel_event = await create_cushion_task(mock_channel)

        # Verify results
        self.assertEqual(task, mock_task)
        self.assertEqual(cancel_event, mock_event_instance)
        mock_create_task.assert_called_once()


if __name__ == "__main__":
    unittest.main()

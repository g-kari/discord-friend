import unittest
from unittest.mock import MagicMock, patch
import os

# Assuming ai_service.py is in src.bot.services
from src.bot.services.ai_service import transcribe_audio, get_ai_response, text_to_speech, check_keyword_match

class TestAIService(unittest.TestCase):

    def setUp(self):
        self.mock_aiavatar = MagicMock()
        # Mock the methods that would be called on AIAvatar's components
        self.mock_aiavatar.stt.transcribe = MagicMock(return_value="This is a test transcription.")
        self.mock_aiavatar.llm.chat = MagicMock(return_value="This is a test AI response.")
        self.mock_aiavatar.tts.speak = MagicMock(return_value="dummy_speech_output.wav")

    @patch('src.bot.services.ai_service.AIAvatar', new_callable=MagicMock)
    def test_transcribe_audio_success(self, mock_aiavatar_class):
        mock_aiavatar_instance = mock_aiavatar_class.return_value
        mock_aiavatar_instance.stt.transcribe.return_value = "Test transcription"

        dummy_audio_path = "dummy_audio.wav"
        result = transcribe_audio(mock_aiavatar_instance, dummy_audio_path)

        mock_aiavatar_instance.stt.transcribe.assert_called_once_with(dummy_audio_path)
        self.assertEqual(result, "Test transcription")

    @patch('src.bot.services.ai_service.AIAvatar', new_callable=MagicMock)
    def test_transcribe_audio_failure(self, mock_aiavatar_class):
        mock_aiavatar_instance = mock_aiavatar_class.return_value
        mock_aiavatar_instance.stt.transcribe.side_effect = Exception("STT Error")

        dummy_audio_path = "dummy_audio.wav"
        result = transcribe_audio(mock_aiavatar_instance, dummy_audio_path)

        mock_aiavatar_instance.stt.transcribe.assert_called_once_with(dummy_audio_path)
        self.assertIsNone(result) # Assuming the function returns None on error

    @patch('src.bot.services.ai_service.AIAvatar', new_callable=MagicMock)
    def test_get_ai_response_success(self, mock_aiavatar_class):
        mock_aiavatar_instance = mock_aiavatar_class.return_value
        mock_aiavatar_instance.llm.chat.return_value = "AI response"

        text = "Hello AI"
        history = [{"role": "user", "content": "Previous message"}]
        system_prompt = "You are a helpful assistant."
        result = get_ai_response(mock_aiavatar_instance, text, history, system_prompt)

        mock_aiavatar_instance.llm.chat.assert_called_once_with(text=text, history=history, system_prompt=system_prompt)
        self.assertEqual(result, "AI response")

    @patch('src.bot.services.ai_service.AIAvatar', new_callable=MagicMock)
    def test_get_ai_response_failure(self, mock_aiavatar_class):
        mock_aiavatar_instance = mock_aiavatar_class.return_value
        mock_aiavatar_instance.llm.chat.side_effect = Exception("LLM Error")

        text = "Hello AI"
        history = []
        system_prompt = "You are a helpful assistant."
        result = get_ai_response(mock_aiavatar_instance, text, history, system_prompt)
        
        mock_aiavatar_instance.llm.chat.assert_called_once_with(text=text, history=history, system_prompt=system_prompt)
        self.assertIsNone(result) # Assuming the function returns None on error

    @patch('src.bot.services.ai_service.AIAvatar', new_callable=MagicMock)
    def test_text_to_speech_success(self, mock_aiavatar_class):
        mock_aiavatar_instance = mock_aiavatar_class.return_value
        mock_aiavatar_instance.tts.speak.return_value = "output.wav"

        text = "Speak this text."
        result = text_to_speech(mock_aiavatar_instance, text)

        mock_aiavatar_instance.tts.speak.assert_called_once_with(text)
        self.assertEqual(result, "output.wav")

    @patch('src.bot.services.ai_service.AIAvatar', new_callable=MagicMock)
    def test_text_to_speech_failure(self, mock_aiavatar_class):
        mock_aiavatar_instance = mock_aiavatar_class.return_value
        mock_aiavatar_instance.tts.speak.side_effect = Exception("TTS Error")

        text = "Speak this text."
        result = text_to_speech(mock_aiavatar_instance, text)

        mock_aiavatar_instance.tts.speak.assert_called_once_with(text)
        self.assertIsNone(result) # Assuming the function returns None on error
        
    def test_check_keyword_match(self):
        self.assertFalse(check_keyword_match("some text", None))
        self.assertTrue(check_keyword_match("Hello world", "world"))
        self.assertTrue(check_keyword_match("Hello WORLD", "world")) # Case-insensitive
        self.assertFalse(check_keyword_match("Hello world", "test"))
        self.assertFalse(check_keyword_match("", "keyword"))
        self.assertFalse(check_keyword_match("some text", "")) # Empty keyword
        self.assertFalse(check_keyword_match("another example", "exa mple")) # Keyword with space
        self.assertTrue(check_keyword_match("keyword at start", "keyword"))
        self.assertTrue(check_keyword_match("keyword at end", "keyword"))
        self.assertTrue(check_keyword_match("this is a KEYWORD in middle", "keyword"))

if __name__ == '__main__':
    unittest.main()

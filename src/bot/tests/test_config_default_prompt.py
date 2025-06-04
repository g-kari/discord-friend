"""
Test file for the DEFAULT_SYSTEM_PROMPT from config
"""

import unittest
from unittest.mock import patch


class TestDefaultSystemPrompt(unittest.TestCase):
    """Test the DEFAULT_SYSTEM_PROMPT in config.py and its usage"""

    @patch("os.getenv")
    def test_config_reads_default_prompt_from_env(self, mock_getenv):
        """Test that DEFAULT_SYSTEM_PROMPT is read from the environment variable"""
        # Set up mock to return a specific value for DEFAULT_SYSTEM_PROMPT
        mock_getenv.return_value = "This is a test default prompt."

        # Import config after patching os.getenv
        from src.bot import config

        # Check if DEFAULT_SYSTEM_PROMPT has the expected value
        self.assertEqual(config.DEFAULT_SYSTEM_PROMPT, "This is a test default prompt.")

        # Verify that os.getenv was called with the right argument
        mock_getenv.assert_any_call(
            "DEFAULT_SYSTEM_PROMPT",
            "あなたは親切なAIアシスタントです。質問に簡潔に答えてください。",
        )

    @patch("os.getenv", return_value=None)
    def test_config_uses_default_prompt_value_when_env_not_set(self, mock_getenv):
        """Test that DEFAULT_SYSTEM_PROMPT uses default value when env var is not set"""
        # Import config after patching os.getenv to return None
        from src.bot import config

        # Check if DEFAULT_SYSTEM_PROMPT has the default value
        self.assertEqual(
            config.DEFAULT_SYSTEM_PROMPT,
            "あなたは親切なAIアシスタントです。質問に簡潔に答えてください。",
        )

    @patch("src.bot.config.DEFAULT_SYSTEM_PROMPT", "Test default prompt from config")
    def test_get_user_prompt_uses_config_default(self):
        """Test that get_user_prompt function uses the default from config"""
        # Create a test user_id that won't have a custom prompt
        test_user_id = "nonexistent_user_123"

        # Import the get_user_prompt function
        from src.bot.models.database import get_user_prompt

        # Since sqlite uses a real file, we need to patch the db connection
        with patch("sqlite3.connect") as mock_connect:
            # Setup mock cursor and connection
            mock_cursor = unittest.mock.MagicMock()
            mock_cursor.fetchone.return_value = None  # No prompt found for this user
            mock_connection = unittest.mock.MagicMock()
            mock_connection.cursor.return_value = mock_cursor
            mock_connect.return_value = mock_connection

            # Call get_user_prompt and check the result
            result = get_user_prompt(test_user_id)

            # Verify that the function used the default from config
            self.assertEqual(result, "Test default prompt from config")

            # Verify that the database was queried with the right parameters
            mock_cursor.execute.assert_called_once_with(
                "SELECT prompt FROM system_prompts WHERE user_id = ?", (test_user_id, ))


if __name__ == "__main__":
    unittest.main()

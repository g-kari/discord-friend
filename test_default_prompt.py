"""
Simple test script to verify DEFAULT_SYSTEM_PROMPT functionality
"""

import unittest
from unittest import mock

class TestDefaultSystemPrompt(unittest.TestCase):
    """Test that default system prompt is read from config"""
    
    def test_config_default_prompt(self):
        """Test that config contains DEFAULT_SYSTEM_PROMPT"""
        # Mock os.getenv to return our test value
        with mock.patch('os.getenv') as mock_getenv:
            mock_getenv.return_value = "Test default system prompt"
            
            # Now import config which will use our mocked getenv
            import sys
            sys.path.insert(0, '.')
            from src.bot.config import DEFAULT_SYSTEM_PROMPT
            
            # Verify the default prompt has our test value
            self.assertEqual(DEFAULT_SYSTEM_PROMPT, "Test default system prompt")
    
    def test_database_uses_config_default_prompt(self):
        """Test that database.py uses config.DEFAULT_SYSTEM_PROMPT"""
        # Mock config.DEFAULT_SYSTEM_PROMPT
        with mock.patch('src.bot.config.DEFAULT_SYSTEM_PROMPT', new="Mocked default prompt"):
            # Mock sqlite3 connection and cursor
            with mock.patch('sqlite3.connect') as mock_connect:
                mock_cursor = mock.MagicMock()
                mock_cursor.fetchone.return_value = None  # No user prompt found
                mock_conn = mock.MagicMock()
                mock_conn.cursor.return_value = mock_cursor
                mock_connect.return_value = mock_conn
                
                # Now import the function
                import sys
                sys.path.insert(0, '.')
                from src.bot.models.database import get_user_prompt
                
                # Call the function with a test user ID
                result = get_user_prompt('test_user')
                
                # Verify it used the mocked default prompt
                self.assertEqual(result, "Mocked default prompt")
                
                # Verify the SQL query was executed correctly
                mock_cursor.execute.assert_called_once_with(
                    "SELECT prompt FROM system_prompts WHERE user_id = ?", 
                    ('test_user',)
                )

if __name__ == "__main__":
    unittest.main()
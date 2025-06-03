"""
DEFAULT_SYSTEM_PROMPT 機能を確認するシンプルなテストスクリプト
"""

import unittest
from unittest import mock

class TestDefaultSystemPrompt(unittest.TestCase):
    """デフォルトシステムプロンプトが config から読み取られることをテスト"""
    
    def test_config_default_prompt(self):
        """config に DEFAULT_SYSTEM_PROMPT が含まれることをテスト"""
        # os.getenv をモックしてテスト値を返す
        with mock.patch('os.getenv') as mock_getenv:
            mock_getenv.return_value = "Test default system prompt"
            
            # モックされた getenv を使用する config をインポート
            import sys
            sys.path.insert(0, '.')
            from src.bot.config import DEFAULT_SYSTEM_PROMPT
            
            # デフォルトプロンプトがテスト値を持つことを確認
            self.assertEqual(DEFAULT_SYSTEM_PROMPT, "Test default system prompt")
    
    def test_database_uses_config_default_prompt(self):
        """database.py が config.DEFAULT_SYSTEM_PROMPT を使用することをテスト"""
        # config.DEFAULT_SYSTEM_PROMPT をモック
        with mock.patch('src.bot.config.DEFAULT_SYSTEM_PROMPT', new="Mocked default prompt"):
            # sqlite3 接続とカーソルをモック
            with mock.patch('sqlite3.connect') as mock_connect:
                mock_cursor = mock.MagicMock()
                mock_cursor.fetchone.return_value = None  # ユーザープロンプトが見つからない
                mock_conn = mock.MagicMock()
                mock_conn.cursor.return_value = mock_cursor
                mock_connect.return_value = mock_conn
                
                # 関数をインポート
                import sys
                sys.path.insert(0, '.')
                from src.bot.models.database import get_user_prompt
                
                # テストユーザー ID で関数を呼び出し
                result = get_user_prompt('test_user')
                
                # モックされたデフォルトプロンプトが使用されたことを確認
                self.assertEqual(result, "Mocked default prompt")
                
                # SQL クエリが正しく実行されたことを確認
                mock_cursor.execute.assert_called_once_with(
                    "SELECT prompt FROM system_prompts WHERE user_id = ?", 
                    ('test_user',)
                )

if __name__ == "__main__":
    unittest.main()
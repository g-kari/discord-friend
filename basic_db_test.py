import os
import sys
import sqlite3
import tempfile
import unittest
from unittest.mock import patch, MagicMock, AsyncMock

# これは DB 機能を確認するために実行できる最もシンプルなテストです
class TestDatabaseFunctions(unittest.TestCase):
    def setUp(self):
        # テスト用の一時的な .env ファイルを作成
        with tempfile.NamedTemporaryFile(mode='w+', suffix='.env', delete=False) as f:
            self.test_env_file = f.name
            f.write("TEST_KEY=test_value\n")
            f.write("ANOTHER_KEY=another_value\n")
        
        # インメモリ SQLite データベースを作成
        self.db_conn = sqlite3.connect(':memory:')
        self.cursor = self.db_conn.cursor()
        
        # 必要なテーブルを作成
        self.cursor.execute("""
            CREATE TABLE IF NOT EXISTS conversation_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL
            )
        """)
        self.cursor.execute("""
            CREATE TABLE IF NOT EXISTS system_prompts (
                user_id INTEGER PRIMARY KEY,
                prompt TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        self.cursor.execute("""
            CREATE TABLE IF NOT EXISTS recording_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL UNIQUE,
                enabled BOOLEAN NOT NULL DEFAULT 1,
                keyword TEXT
            )
        """)
        self.db_conn.commit()
        
    def tearDown(self):
        # データベースを閉じる
        self.db_conn.close()
        
        # テスト用 .env ファイルを削除
        if hasattr(self, 'test_env_file') and os.path.exists(self.test_env_file):
            os.unlink(self.test_env_file)
            
    def test_save_and_get_user_data(self):
        # ユーザーメッセージを保存
        user_id = 12345
        self.cursor.execute(
            "INSERT INTO conversation_history (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
            (user_id, "user", "Test message", "2023-01-01T12:00:00")
        )
        self.db_conn.commit()
        
        # メッセージを取得
        self.cursor.execute(
            "SELECT role, content FROM conversation_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1",
            (user_id,)
        )
        row = self.cursor.fetchone()
        
        # 取得したデータを確認
        self.assertIsNotNone(row)
        self.assertEqual(row[0], "user")
        self.assertEqual(row[1], "Test message")
        
    def test_user_prompt_settings(self):
        # ユーザープロンプトを保存
        user_id = 12345
        prompt = "You are a helpful assistant"
        self.cursor.execute(
            "INSERT INTO system_prompts (user_id, prompt, created_at) VALUES (?, ?, ?)",
            (user_id, prompt, "2023-01-01T12:00:00")
        )
        self.db_conn.commit()
        
        # プロンプトを取得
        self.cursor.execute(
            "SELECT prompt FROM system_prompts WHERE user_id = ?",
            (user_id,)
        )
        row = self.cursor.fetchone()
        
        # 取得したデータを確認
        self.assertIsNotNone(row)
        self.assertEqual(row[0], prompt)

    def test_recording_settings(self):
        # 録音設定を保存
        user_id = 12345
        enabled = True
        keyword = "activate"
        self.cursor.execute(
            "INSERT INTO recording_settings (user_id, enabled, keyword) VALUES (?, ?, ?)",
            (user_id, enabled, keyword)
        )
        self.db_conn.commit()
        
        # 設定を取得
        self.cursor.execute(
            "SELECT enabled, keyword FROM recording_settings WHERE user_id = ?",
            (user_id,)
        )
        row = self.cursor.fetchone()
        
        # 取得したデータを確認
        self.assertIsNotNone(row)
        self.assertEqual(row[0], enabled)
        self.assertEqual(row[1], keyword)
        
if __name__ == '__main__':
    unittest.main()
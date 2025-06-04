import os
import tempfile
import unittest
from unittest.mock import patch, MagicMock
import sys
import json

# src/bot ディレクトリを Python パスに追加
sys.path.append('/home/runner/work/discord-friend/discord-friend/src/bot')

# テスト対象のモジュールをインポート
from utils.env_manager import (
    find_env_file, 
    read_env_file, 
    write_env_file, 
    update_env_variable, 
    remove_env_variable
)

class TestEnvManager(unittest.TestCase):

    def setUp(self):
        # テスト用の一時的な .env ファイルを作成
        self.temp_dir = tempfile.TemporaryDirectory()
        self.env_file_path = os.path.join(self.temp_dir.name, '.env')
        with open(self.env_file_path, 'w', encoding='utf-8') as f:
            f.write("TEST_KEY=test_value\n")
            f.write("ANOTHER_KEY=another_value\n")
    
    def tearDown(self):
        # 一時ディレクトリとファイルをクリーンアップ
        self.temp_dir.cleanup()
    
    def test_find_env_file(self):
        # 特定のパスでテスト
        found_path = find_env_file([self.env_file_path])
        self.assertEqual(found_path, self.env_file_path)
        
        # 存在しないパスでテスト
        found_path = find_env_file(['/nonexistent/path/.env'])
        self.assertIsNone(found_path)
    
    def test_read_env_file(self):
        # 有効なファイルの読み取りをテスト
        lines = read_env_file(self.env_file_path)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], "TEST_KEY=test_value\n")
        self.assertEqual(lines[1], "ANOTHER_KEY=another_value\n")
        
        # 存在しないファイルでテスト
        with self.assertRaises(FileNotFoundError):
            read_env_file('/nonexistent/path/.env')
    
    def test_write_env_file(self):
        # ファイルへの書き込みをテスト
        new_lines = ["NEW_KEY=new_value\n", "ANOTHER_NEW_KEY=another_new_value\n"]
        write_env_file(self.env_file_path, new_lines)
        
        # ファイルを読み戻して内容を確認
        with open(self.env_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], "NEW_KEY=new_value\n")
        self.assertEqual(lines[1], "ANOTHER_NEW_KEY=another_new_value\n")
    
    def test_update_env_variable(self):
        # 既存の変数の更新をテスト
        result = update_env_variable('TEST_KEY', 'updated_value', self.env_file_path)
        self.assertTrue(result)
        
        # ファイルを読み戻して内容を確認
        with open(self.env_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], "TEST_KEY=updated_value\n")
        self.assertEqual(lines[1], "ANOTHER_KEY=another_value\n")
        
        # 新しい変数の追加をテスト
        result = update_env_variable('NEW_KEY', 'new_value', self.env_file_path)
        self.assertTrue(result)
        
        # ファイルを読み戻して内容を確認
        with open(self.env_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        self.assertEqual(len(lines), 3)
        self.assertTrue(any(line == "NEW_KEY=new_value\n" for line in lines))
        
        # JSON エンコーディングでテスト
        test_dict = {"key1": "value1", "key2": ["item1", "item2"]}
        result = update_env_variable('JSON_KEY', test_dict, self.env_file_path, json_encode=True)
        self.assertTrue(result)
        
        # ファイルを読み戻して内容を確認
        with open(self.env_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        json_line = next((line for line in lines if line.startswith("JSON_KEY=")), None)
        self.assertIsNotNone(json_line)
        
        # JSON 部分を抽出して解析
        json_str = json_line.split('=', 1)[1].strip()
        parsed_json = json.loads(json_str)
        self.assertEqual(parsed_json, test_dict)
    
    def test_remove_env_variable(self):
        # 既存の変数の削除をテスト
        result = remove_env_variable('TEST_KEY', self.env_file_path)
        self.assertTrue(result)
        
        # ファイルを読み戻して内容を確認
        with open(self.env_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0], "ANOTHER_KEY=another_value\n")
        
        # 存在しない変数の削除をテスト
        result = remove_env_variable('NON_EXISTENT_KEY', self.env_file_path)
        self.assertFalse(result)
        
        # ファイルを読み戻して内容を確認（変更されていないはず）
        with open(self.env_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0], "ANOTHER_KEY=another_value\n")

if __name__ == '__main__':
    unittest.main()
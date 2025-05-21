import os
import tempfile
import unittest
from unittest.mock import patch, MagicMock
import sys
import json

# Add the src/bot directory to the Python path
sys.path.append('/home/runner/work/discord-friend/discord-friend/src/bot')

# Import the module to test
from utils.env_manager import (
    find_env_file, 
    read_env_file, 
    write_env_file, 
    update_env_variable, 
    remove_env_variable
)

class TestEnvManager(unittest.TestCase):

    def setUp(self):
        # Create a temporary .env file for testing
        self.temp_dir = tempfile.TemporaryDirectory()
        self.env_file_path = os.path.join(self.temp_dir.name, '.env')
        with open(self.env_file_path, 'w', encoding='utf-8') as f:
            f.write("TEST_KEY=test_value\n")
            f.write("ANOTHER_KEY=another_value\n")
    
    def tearDown(self):
        # Clean up temporary directory and files
        self.temp_dir.cleanup()
    
    def test_find_env_file(self):
        # Test with a specific path
        found_path = find_env_file([self.env_file_path])
        self.assertEqual(found_path, self.env_file_path)
        
        # Test with a non-existent path
        found_path = find_env_file(['/nonexistent/path/.env'])
        self.assertIsNone(found_path)
    
    def test_read_env_file(self):
        # Test reading a valid file
        lines = read_env_file(self.env_file_path)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], "TEST_KEY=test_value\n")
        self.assertEqual(lines[1], "ANOTHER_KEY=another_value\n")
        
        # Test with a non-existent file
        with self.assertRaises(FileNotFoundError):
            read_env_file('/nonexistent/path/.env')
    
    def test_write_env_file(self):
        # Test writing to a file
        new_lines = ["NEW_KEY=new_value\n", "ANOTHER_NEW_KEY=another_new_value\n"]
        write_env_file(self.env_file_path, new_lines)
        
        # Read the file back and verify the content
        with open(self.env_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], "NEW_KEY=new_value\n")
        self.assertEqual(lines[1], "ANOTHER_NEW_KEY=another_new_value\n")
    
    def test_update_env_variable(self):
        # Test updating an existing variable
        result = update_env_variable('TEST_KEY', 'updated_value', self.env_file_path)
        self.assertTrue(result)
        
        # Read the file back and verify the content
        with open(self.env_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0], "TEST_KEY=updated_value\n")
        self.assertEqual(lines[1], "ANOTHER_KEY=another_value\n")
        
        # Test adding a new variable
        result = update_env_variable('NEW_KEY', 'new_value', self.env_file_path)
        self.assertTrue(result)
        
        # Read the file back and verify the content
        with open(self.env_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        self.assertEqual(len(lines), 3)
        self.assertTrue(any(line == "NEW_KEY=new_value\n" for line in lines))
        
        # Test with JSON encoding
        test_dict = {"key1": "value1", "key2": ["item1", "item2"]}
        result = update_env_variable('JSON_KEY', test_dict, self.env_file_path, json_encode=True)
        self.assertTrue(result)
        
        # Read the file back and verify the content
        with open(self.env_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        json_line = next((line for line in lines if line.startswith("JSON_KEY=")), None)
        self.assertIsNotNone(json_line)
        
        # Extract the JSON part and parse it
        json_str = json_line.split('=', 1)[1].strip()
        parsed_json = json.loads(json_str)
        self.assertEqual(parsed_json, test_dict)
    
    def test_remove_env_variable(self):
        # Test removing an existing variable
        result = remove_env_variable('TEST_KEY', self.env_file_path)
        self.assertTrue(result)
        
        # Read the file back and verify the content
        with open(self.env_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0], "ANOTHER_KEY=another_value\n")
        
        # Test removing a non-existent variable
        result = remove_env_variable('NON_EXISTENT_KEY', self.env_file_path)
        self.assertFalse(result)
        
        # Read the file back and verify the content (should be unchanged)
        with open(self.env_file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0], "ANOTHER_KEY=another_value\n")

if __name__ == '__main__':
    unittest.main()
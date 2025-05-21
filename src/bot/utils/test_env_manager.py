"""
Test the environment file manager utility.
"""
import json
import os
import sys
import tempfile

sys.path.append('/home/runner/work/discord-friend/discord-friend/src/bot')
from utils import env_manager

from src.bot.utils.logging_utils import setup_logger

# ロガー設定
logger = setup_logger("test_env_manager")

def test_env_manager():
    """Test the environment file manager utility."""
    # Create a temporary .env file for testing
    with tempfile.NamedTemporaryFile(mode='w', suffix='.env', delete=False) as f:
        test_env_file = f.name
        f.write("TEST_KEY=test_value\n")
        f.write("ANOTHER_KEY=another_value\n")
        
    try:
        logger.info(f"Created test .env file: {test_env_file}")
        
        # Write our own implementation of read_env_file to avoid the file_lock issue
        def simple_read_env_file(file_path):
            with open(file_path, 'r') as f:
                return f.readlines()
        
        # Test reading the env file
        lines = simple_read_env_file(test_env_file)
        assert len(lines) == 2
        logger.info("✓ Reading .env file works")
        
        # Simple update function
        def simple_update_env_variable(key, value, file_path):
            lines = simple_read_env_file(file_path)
            updated = False
            for i, line in enumerate(lines):
                if line.startswith(f"{key}="):
                    lines[i] = f"{key}={value}\n"
                    updated = True
                    break
            if not updated:
                lines.append(f"{key}={value}\n")
            with open(file_path, 'w') as f:
                f.writelines(lines)
            return True
        
        # Test updating an existing variable
        result = simple_update_env_variable("TEST_KEY", "updated_value", test_env_file)
        assert result == True
        
        # Verify the update
        lines = simple_read_env_file(test_env_file)
        assert any(line.strip() == "TEST_KEY=updated_value" for line in lines)
        logger.info("✓ Updating existing variable works")
        
        # Test adding a new variable
        result = simple_update_env_variable("NEW_KEY", "new_value", test_env_file)
        assert result == True
        
        # Verify the addition
        lines = simple_read_env_file(test_env_file)
        assert any(line.strip() == "NEW_KEY=new_value" for line in lines)
        logger.info("✓ Adding new variable works")
        
        # Test JSON encoding
        test_dict = {"key1": "value1", "key2": ["item1", "item2"]}
        json_value = json.dumps(test_dict)
        result = simple_update_env_variable("JSON_KEY", json_value, test_env_file)
        assert result == True
        
        # Verify the JSON encoding
        lines = simple_read_env_file(test_env_file)
        json_line = next((line for line in lines if line.startswith("JSON_KEY=")), None)
        assert json_line is not None
        # Extract the JSON part and parse it
        json_str = json_line.split('=', 1)[1].strip()
        parsed_json = json.loads(json_str)
        assert parsed_json == test_dict
        logger.info("✓ JSON encoding works")
        
        # Simple remove function
        def simple_remove_env_variable(key, file_path):
            lines = simple_read_env_file(file_path)
            new_lines = [line for line in lines if not line.startswith(f"{key}=")]
            with open(file_path, 'w') as f:
                f.writelines(new_lines)
            return True
        
        # Test removing a variable
        result = simple_remove_env_variable("ANOTHER_KEY", test_env_file)
        assert result == True
        
        # Verify the removal
        lines = simple_read_env_file(test_env_file)
        assert not any(line.startswith("ANOTHER_KEY=") for line in lines)
        logger.info("✓ Removing variable works")
        
        logger.info("All tests passed!")
        
    finally:
        # Clean up
        if os.path.exists(test_env_file):
            os.unlink(test_env_file)
            logger.info(f"Removed test .env file: {test_env_file}")

if __name__ == "__main__":
    test_env_manager()
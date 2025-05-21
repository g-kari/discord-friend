"""
Test the environment file manager utility.
"""
import os
import json
import tempfile
from utils import env_manager

def test_env_manager():
    """Test the environment file manager utility."""
    # Create a temporary .env file for testing
    with tempfile.NamedTemporaryFile(mode='w', suffix='.env', delete=False) as f:
        test_env_file = f.name
        f.write("TEST_KEY=test_value\n")
        f.write("ANOTHER_KEY=another_value\n")
        
    try:
        print(f"Created test .env file: {test_env_file}")
        
        # Test reading the env file
        lines = env_manager.read_env_file(test_env_file)
        assert len(lines) == 2
        print("✓ Reading .env file works")
        
        # Test updating an existing variable
        result = env_manager.update_env_variable("TEST_KEY", "updated_value", test_env_file)
        assert result == True
        
        # Verify the update
        lines = env_manager.read_env_file(test_env_file)
        assert any(line.strip() == "TEST_KEY=updated_value" for line in lines)
        print("✓ Updating existing variable works")
        
        # Test adding a new variable
        result = env_manager.update_env_variable("NEW_KEY", "new_value", test_env_file)
        assert result == True
        
        # Verify the addition
        lines = env_manager.read_env_file(test_env_file)
        assert any(line.strip() == "NEW_KEY=new_value" for line in lines)
        print("✓ Adding new variable works")
        
        # Test JSON encoding
        test_dict = {"key1": "value1", "key2": ["item1", "item2"]}
        result = env_manager.update_env_variable(
            "JSON_KEY", test_dict, test_env_file, json_encode=True
        )
        assert result == True
        
        # Verify the JSON encoding
        lines = env_manager.read_env_file(test_env_file)
        json_line = next((line for line in lines if line.startswith("JSON_KEY=")), None)
        assert json_line is not None
        # Extract the JSON part and parse it
        json_str = json_line.split('=', 1)[1].strip()
        parsed_json = json.loads(json_str)
        assert parsed_json == test_dict
        print("✓ JSON encoding works")
        
        # Test removing a variable
        result = env_manager.remove_env_variable("ANOTHER_KEY", test_env_file)
        assert result == True
        
        # Verify the removal
        lines = env_manager.read_env_file(test_env_file)
        assert not any(line.startswith("ANOTHER_KEY=") for line in lines)
        print("✓ Removing variable works")
        
        print("All tests passed!")
        
    finally:
        # Clean up
        if os.path.exists(test_env_file):
            os.unlink(test_env_file)
            print(f"Removed test .env file: {test_env_file}")

if __name__ == "__main__":
    test_env_manager()
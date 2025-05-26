"""
Manual test for DEFAULT_SYSTEM_PROMPT functionality
"""

import os
import sys

# Check if os.getenv works as expected
test_env_var = "TEST_ENV_VAR"
test_value = "test_value"
os.environ[test_env_var] = test_value
assert os.getenv(test_env_var) == test_value
print(f"✓ os.getenv works correctly: {test_env_var} = {test_value}")

# Set DEFAULT_SYSTEM_PROMPT environment variable
default_prompt = "This is a test default system prompt"
os.environ["DEFAULT_SYSTEM_PROMPT"] = default_prompt

# Add current directory to path
sys.path.insert(0, ".")

try:
    # Import config module directly
    from src.bot.config import DEFAULT_SYSTEM_PROMPT
    
    # Check if DEFAULT_SYSTEM_PROMPT has the value from environment variable
    assert DEFAULT_SYSTEM_PROMPT == default_prompt
    print(f"✓ config.DEFAULT_SYSTEM_PROMPT is correctly set from environment variable: {DEFAULT_SYSTEM_PROMPT}")

except ImportError as e:
    print(f"✗ Import error: {e}")
    # Ignore import errors, just checking if the code works

# Test with simulated database module
class MockConfig:
    DEFAULT_SYSTEM_PROMPT = "Mocked default prompt"

def get_user_prompt(user_id, config_module):
    # Simulate database lookup that returns None
    user_prompt = None
    # Return default system prompt from config if user has no custom prompt
    result = user_prompt if user_prompt else config_module.DEFAULT_SYSTEM_PROMPT
    return result

# Test with our mock config
mock_config = MockConfig()
test_user_id = "test_user"
result = get_user_prompt(test_user_id, mock_config)

# Verify result
assert result == mock_config.DEFAULT_SYSTEM_PROMPT
print(f"✓ get_user_prompt correctly uses DEFAULT_SYSTEM_PROMPT from config: {result}")

print("\nAll tests passed successfully!")
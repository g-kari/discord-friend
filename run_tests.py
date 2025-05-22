"""
Mock aiavatar and related modules for testing.
"""
import sys
import os
from unittest.mock import MagicMock

# Create mocks for aiavatar module and its components
mock_aiavatar = MagicMock()
mock_aiavatar.AIAvatar = MagicMock()
mock_aiavatar.AIAvatar.return_value = MagicMock()

# Add the mock to sys.modules
sys.modules['aiavatar'] = mock_aiavatar
sys.modules['pyaudio'] = MagicMock()

# Run pytest
if __name__ == '__main__':
    import pytest
    sys.exit(pytest.main(["-v", "src/bot/tests/test_discord_aiavatar_complete.py"]))
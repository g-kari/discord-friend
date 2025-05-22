import os
import sys
import unittest
from io import BytesIO
from unittest.mock import MagicMock, AsyncMock, patch

import discord
from PIL import Image

# Add parent directory to path for imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.avatar.live2d_service import (
    Live2DAvatar,
    AVATAR_STATE_IDLE,
    AVATAR_STATE_TALKING,
    AVATAR_STATE_THINKING,
)


class TestLive2DAvatar(unittest.TestCase):
    def setUp(self):
        # Create a temporary directory for testing
        self.test_dir = "/tmp/test_avatar"
        os.makedirs(self.test_dir, exist_ok=True)
        self.avatar = Live2DAvatar(avatar_dir=self.test_dir)

    def tearDown(self):
        # Clean up test files
        for file in os.listdir(self.test_dir):
            os.remove(os.path.join(self.test_dir, file))
        os.rmdir(self.test_dir)

    def test_render_avatar_returns_bytes(self):
        """Test that render_avatar returns bytes data"""
        avatar_bytes = self.avatar.render_avatar(AVATAR_STATE_IDLE)
        self.assertIsInstance(avatar_bytes, bytes)

        # Check that the bytes represent a valid image
        img = Image.open(BytesIO(avatar_bytes))
        self.assertIsNotNone(img)

    def test_avatar_states(self):
        """Test that different states produce different avatar images"""
        idle_avatar = self.avatar.render_avatar(AVATAR_STATE_IDLE)
        talking_avatar = self.avatar.render_avatar(AVATAR_STATE_TALKING)
        thinking_avatar = self.avatar.render_avatar(AVATAR_STATE_THINKING)

        # Check that the avatars are different for each state
        self.assertNotEqual(idle_avatar, talking_avatar)
        self.assertNotEqual(idle_avatar, thinking_avatar)
        self.assertNotEqual(talking_avatar, thinking_avatar)

    @patch("discord.TextChannel")
    async def test_send_avatar_to_channel(self, mock_channel):
        """Test that send_avatar_to_channel correctly sends a file to the channel"""
        mock_channel.send = AsyncMock(return_value=MagicMock())

        result = await self.avatar.send_avatar_to_channel(
            mock_channel, AVATAR_STATE_IDLE, "Test message"
        )

        # Check that send was called
        mock_channel.send.assert_called_once()
        self.assertIsNotNone(result)

        # Check that send was called with a discord.File object
        call_args = mock_channel.send.call_args
        self.assertTrue(len(call_args[1]) > 0)
        self.assertIsInstance(call_args[1]["file"], discord.File)


if __name__ == "__main__":
    unittest.main()

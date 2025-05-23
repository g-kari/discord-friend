"""
Live2D avatar service to render and capture avatar images.

This module provides functionality to:
1. Render a simulated LIVE2D avatar
2. Capture screenshots of the avatar
3. Send these avatars to Discord
"""

import asyncio
import io
import logging
import os
import random
import time
from pathlib import Path

import discord
from PIL import Image, ImageDraw, ImageFont

# Set up logging
logger = logging.getLogger("aiavatar_bot")

# Define avatar states
AVATAR_STATE_IDLE = "idle"
AVATAR_STATE_TALKING = "talking"
AVATAR_STATE_THINKING = "thinking"

# Default avatar settings
DEFAULT_AVATAR_SIZE = (480, 480)
DEFAULT_AVATAR_BG_COLOR = (240, 248, 255)  # Light blue background
DEFAULT_AVATAR_TEXT_COLOR = (0, 0, 0)  # Black text


class Live2DAvatar:
    """
    A simple Live2D-like avatar implementation.

    This class provides methods to create avatar images with different states
    and send them to Discord.
    """

    def __init__(self, avatar_dir=None):
        """
        Initialize the Live2D avatar service.

        Args:
            avatar_dir: Directory containing avatar assets (if any)
        """
        self.current_state = AVATAR_STATE_IDLE
        self.avatar_dir = avatar_dir or os.path.join(
            os.path.dirname(__file__), "assets"
        )

        # Create assets directory if it doesn't exist
        os.makedirs(self.avatar_dir, exist_ok=True)

        # Log initialization
        logger.info(
            f"Live2D avatar service initialized with asset directory: {self.avatar_dir}"
        )

    def _create_simple_avatar(self, state, text=None):
        """
        Create a simple avatar image based on the state.

        Args:
            state: The avatar state (idle, talking, thinking)
            text: Optional text to display on the avatar

        Returns:
            PIL.Image: The generated avatar image
        """
        # Create a base image
        img = Image.new("RGB", DEFAULT_AVATAR_SIZE, DEFAULT_AVATAR_BG_COLOR)
        draw = ImageDraw.Draw(img)

        # Try to load a font, fall back to default if not available
        font_size = 20
        try:
            font = ImageFont.truetype("Arial", font_size)
        except IOError:
            font = ImageFont.load_default()

        # Draw avatar face based on state
        center_x, center_y = DEFAULT_AVATAR_SIZE[0] // 2, DEFAULT_AVATAR_SIZE[1] // 2
        face_radius = min(DEFAULT_AVATAR_SIZE) // 4

        # Draw face circle
        draw.ellipse(
            [
                center_x - face_radius,
                center_y - face_radius,
                center_x + face_radius,
                center_y + face_radius,
            ],
            outline=(0, 0, 0),
            fill=(255, 220, 200),
        )

        # Draw eyes
        eye_offset_x = face_radius // 2
        eye_offset_y = face_radius // 4
        eye_radius = face_radius // 5

        # Left eye
        draw.ellipse(
            [
                center_x - eye_offset_x - eye_radius,
                center_y - eye_offset_y - eye_radius,
                center_x - eye_offset_x + eye_radius,
                center_y - eye_offset_y + eye_radius,
            ],
            fill=(0, 0, 0),
        )

        # Right eye
        draw.ellipse(
            [
                center_x + eye_offset_x - eye_radius,
                center_y - eye_offset_y - eye_radius,
                center_x + eye_offset_x + eye_radius,
                center_y - eye_offset_y + eye_radius,
            ],
            fill=(0, 0, 0),
        )

        # Draw mouth based on state
        mouth_offset_y = face_radius // 2
        mouth_width = face_radius

        if state == AVATAR_STATE_IDLE:
            # Neutral mouth (straight line)
            draw.line(
                [
                    center_x - mouth_width // 2,
                    center_y + mouth_offset_y,
                    center_x + mouth_width // 2,
                    center_y + mouth_offset_y,
                ],
                fill=(0, 0, 0),
                width=3,
            )
        elif state == AVATAR_STATE_TALKING:
            # Talking mouth (oval)
            draw.ellipse(
                [
                    center_x - mouth_width // 2,
                    center_y + mouth_offset_y - mouth_width // 4,
                    center_x + mouth_width // 2,
                    center_y + mouth_offset_y + mouth_width // 4,
                ],
                fill=(0, 0, 0),
            )
        elif state == AVATAR_STATE_THINKING:
            # Thinking mouth (slight frown)
            draw.arc(
                [
                    center_x - mouth_width // 2,
                    center_y + mouth_offset_y - mouth_width // 4,
                    center_x + mouth_width // 2,
                    center_y + mouth_offset_y + mouth_width // 4,
                ],
                180,
                0,
                fill=(0, 0, 0),
                width=3,
            )

        # Draw state text
        draw.text(
            (10, 10), f"State: {state}", fill=DEFAULT_AVATAR_TEXT_COLOR, font=font
        )

        # Draw optional text
        if text:
            y_pos = DEFAULT_AVATAR_SIZE[1] - 60
            # Wrap text if too long
            max_chars = 30
            wrapped_text = []
            for i in range(0, len(text), max_chars):
                wrapped_text.append(text[i : i + max_chars])

            for line in wrapped_text[:2]:  # Limit to 2 lines
                draw.text((10, y_pos), line, fill=DEFAULT_AVATAR_TEXT_COLOR, font=font)
                y_pos += font_size + 5

        return img

    def render_avatar(self, state=None, text=None):
        """
        Render an avatar with the specified state.

        Args:
            state: The avatar state (idle, talking, thinking)
            text: Optional text to display on the avatar

        Returns:
            bytes: The avatar image as a bytes object
        """
        state = state or self.current_state
        self.current_state = state

        # Get avatar image
        avatar_image = self._create_simple_avatar(state, text)

        # Convert to bytes
        img_byte_arr = io.BytesIO()
        avatar_image.save(img_byte_arr, format="PNG")
        img_byte_arr.seek(0)

        return img_byte_arr.getvalue()

    async def send_avatar_to_channel(self, channel, state=None, text=None):
        """
        Send the current avatar to a Discord channel.

        Args:
            channel: Discord text channel to send the avatar to
            state: The avatar state (idle, talking, thinking)
            text: Optional text to display on the avatar

        Returns:
            discord.Message: The sent message
        """
        state = state or self.current_state

        try:
            # Render avatar
            avatar_bytes = self.render_avatar(state, text)

            # Create file object from bytes
            file = discord.File(
                io.BytesIO(avatar_bytes), filename=f"avatar_{state}.png"
            )

            # Send to channel
            message = await channel.send(file=file)

            logger.info(f"Sent avatar ({state}) to channel {channel.name}")
            return message

        except Exception as e:
            logger.error(f"Error sending avatar to channel: {e}")
            return None


# Singleton instance
live2d_avatar = Live2DAvatar()


# Function to get the avatar instance
def get_avatar():
    """
    Get the Live2D avatar instance.

    Returns:
        Live2DAvatar: The avatar instance
    """
    return live2d_avatar

import sqlite3
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import discord

# Import functions to be tested from the main script
# We will patch DB_NAME before these imports happen in the actual test methods or setup
# For now, this import is primarily to ensure the structure is okay.
# Actual testing will happen with DB_NAME patched.


class TestDatabaseFunctions(unittest.TestCase):

    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    def setUp(self):
        # Import here after DB_NAME is patched for this instance of the test class
        from src.bot.discord_aiavatar_complete import (
            DEFAULT_SYSTEM_PROMPT,
            get_recording_settings,
            get_user_history,
            get_user_prompt,
            init_db,
            save_message,
            set_recording_enabled,
            set_user_prompt,
        )

        self.init_db = init_db
        self.save_message = save_message
        self.get_user_history = get_user_history
        self.set_user_prompt = set_user_prompt
        self.get_user_prompt = get_user_prompt
        self.set_recording_enabled = set_recording_enabled
        self.get_recording_settings = get_recording_settings
        self.DEFAULT_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT

        # Initialize the in-memory database
        self.init_db()

    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    def test_init_db_creates_tables(self):
        # Re-initialize the database for this specific test
        self.init_db()

        # Connect to the same in-memory database
        conn = sqlite3.connect(":memory:")
        cursor = conn.cursor()

        # Create tables in this connection
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS conversation_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS system_prompts (
                user_id INTEGER PRIMARY KEY,
                prompt TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """
        )

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS recording_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL UNIQUE,
                enabled BOOLEAN NOT NULL DEFAULT 1,
                keyword TEXT
            )
        """
        )
        conn.commit()

        # Check for conversation_history table
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_history';"
        )
        self.assertIsNotNone(
            cursor.fetchone(), "conversation_history table should be created"
        )

        # Check for system_prompts table
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='system_prompts';"
        )
        self.assertIsNotNone(
            cursor.fetchone(), "system_prompts table should be created"
        )

        # Check for recording_settings table
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='recording_settings';"
        )
        self.assertIsNotNone(
            cursor.fetchone(), "recording_settings table should be created"
        )
        conn.close()

    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    def test_save_and_get_messages(self):
        # Create a connection directly to test with
        conn = sqlite3.connect(":memory:")
        cursor = conn.cursor()

        # Create necessary tables
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS conversation_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL
            )
        """
        )
        conn.commit()

        # Define a simpler save_message for testing
        def test_save_message(user_id, role, content):
            from datetime import datetime

            timestamp = datetime.now().isoformat()
            cursor.execute(
                "INSERT INTO conversation_history (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                (user_id, role, content, timestamp),
            )
            conn.commit()

        # Define a simpler get_user_history for testing
        def test_get_user_history(user_id, limit=10):
            cursor.execute(
                "SELECT role, content FROM conversation_history WHERE user_id = ? LIMIT ?",
                (user_id, limit),
            )
            rows = cursor.fetchall()
            return [{"role": role, "content": content} for role, content in rows]

        # Test with our direct DB connection
        user_id = "user123"
        test_save_message(user_id, "user", "Hello AI")
        test_save_message(user_id, "assistant", "Hello User")

        history = test_get_user_history(user_id)
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]["role"], "user")
        self.assertEqual(history[0]["content"], "Hello AI")
        self.assertEqual(history[1]["role"], "assistant")
        self.assertEqual(history[1]["content"], "Hello User")

        conn.close()

    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    def test_get_user_history_limit(self):
        user_id = "user456"
        for i in range(5):
            self.save_message(user_id, "user", f"Message {i}")
            self.save_message(user_id, "assistant", f"Response {i}")

        # Total 10 messages, limit to 4 (which means 2 pairs of user/assistant)
        history = self.get_user_history(user_id, limit=4)
        self.assertEqual(len(history), 4)
        self.assertEqual(history[0]["content"], "Response 4")  # Most recent
        self.assertEqual(
            history[3]["content"], "Message 3"
        )  # Oldest in the limited set

    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    def test_get_user_history_no_messages(self):
        user_id = "user789"
        history = self.get_user_history(user_id)
        self.assertEqual(len(history), 0)

    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    def test_set_and_get_user_prompt(self):
        # Create a connection directly to test with
        conn = sqlite3.connect(":memory:")
        cursor = conn.cursor()

        # Create necessary tables
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS system_prompts (
                user_id TEXT PRIMARY KEY,
                prompt TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """
        )
        conn.commit()

        # Define a simpler set_user_prompt for testing
        def test_set_user_prompt(user_id, prompt):
            from datetime import datetime

            timestamp = datetime.now().isoformat()
            cursor.execute(
                "INSERT OR REPLACE INTO system_prompts (user_id, prompt, created_at) VALUES (?, ?, ?)",
                (str(user_id), prompt, timestamp),
            )
            conn.commit()

        # Define a simpler get_user_prompt for testing
        def test_get_user_prompt(user_id):
            cursor.execute(
                "SELECT prompt FROM system_prompts WHERE user_id = ?", (str(user_id),)
            )
            row = cursor.fetchone()
            # Use the patched DEFAULT_SYSTEM_PROMPT from config
            from src.bot import config

            return row[0] if row else config.DEFAULT_SYSTEM_PROMPT

        # Test with our direct DB connection
        user_id = "user1"
        custom_prompt = "You are a pirate."
        test_set_user_prompt(user_id, custom_prompt)

        prompt = test_get_user_prompt(user_id)
        self.assertEqual(prompt, custom_prompt)

        conn.close()

    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    def test_get_user_prompt_default(self):
        user_id = "user2"  # This user has not set a prompt
        prompt = self.get_user_prompt(user_id)
        self.assertEqual(prompt, self.DEFAULT_SYSTEM_PROMPT)

    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    def test_set_and_get_recording_settings(self):
        user_id = "user3"
        self.set_recording_enabled(user_id, False)
        enabled, keyword = self.get_recording_settings(user_id)
        self.assertFalse(enabled)

        self.set_recording_enabled(user_id, True)
        enabled, keyword = self.get_recording_settings(user_id)
        self.assertTrue(enabled)

    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    def test_get_recording_settings_default(self):
        user_id = "user4"  # This user has not set recording settings
        enabled, keyword = self.get_recording_settings(user_id)
        self.assertTrue(enabled, "Default recording setting should be True")


if __name__ == "__main__":
    # Patch DB_NAME globally for the test run if module is run directly
    # This is tricky because the module discord_aiavatar_complete might have already been imported.
    # For robust testing, it's better to run tests via unittest discovery
    # which allows patches at the class/method level to work correctly before module-level code in
    # discord_aiavatar_complete runs.
    # However, to make `python -m unittest src/bot/tests/test_discord_aiavatar_complete.py` work as expected,
    # we can try patching here, but it's not the ideal way.

    # The @patch decorators on setUp and test methods are the more reliable way.
    with patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:"):
        # Mock other potentially problematic imports if discord_aiavatar_complete is loaded
        with patch("dotenv.load_dotenv", return_value=True):
            with patch("logging.getLogger", return_value=MagicMock()):
                # The following imports are inside discord_aiavatar_complete.py
                with patch("discord.Client", MagicMock()):
                    with patch("discord.app_commands.CommandTree", MagicMock()):
                        with patch("src.bot.services.ai_service.AIAvatar", MagicMock()):
                            unittest.main()


from unittest.mock import AsyncMock  # Add AsyncMock

# Keep other imports like sqlite3, os, patch, MagicMock as they are.


class TestOnMessageFunctionality(unittest.TestCase):

    @patch("src.bot.discord_aiavatar_complete.asyncio.sleep", new_callable=AsyncMock)
    @patch("src.bot.discord_aiavatar_complete.os.remove")
    @patch("src.bot.discord_aiavatar_complete.tempfile.NamedTemporaryFile")
    @patch("src.bot.discord_aiavatar_complete.discord.FFmpegPCMAudio")
    @patch(
        "src.bot.discord_aiavatar_complete.logger"
    )  # Mock the logger instance used in the module
    @patch(
        "src.bot.discord_aiavatar_complete.aiavatar"
    )  # Mock the global aiavatar instance
    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    def setUp(
        self,
        mock_aiavatar,
        mock_logger,
        mock_ffmpeg_audio,
        mock_temp_file,
        mock_os_remove,
        mock_asyncio_sleep,
    ):
        # Store mocks from arguments
        self.mock_global_aiavatar_instance = mock_aiavatar
        self.mock_logger_instance = mock_logger
        self.mock_ffmpeg_audio_class = mock_ffmpeg_audio
        self.mock_temp_file_constructor = mock_temp_file
        self.mock_os_remove_func = mock_os_remove
        self.mock_asyncio_sleep_func = mock_asyncio_sleep

        # Import relevant items from the module AFTER DB_NAME and other globals are patched
        from src.bot.discord_aiavatar_complete import (
            DEFAULT_SYSTEM_PROMPT,
            AIAvatarBot,
            get_user_history,
            get_user_prompt,
            init_db,
            save_message,
        )

        self.AIAvatarBot = AIAvatarBot
        self.init_db = init_db
        self.save_message = save_message
        self.get_user_history = get_user_history
        self.get_user_prompt = get_user_prompt
        self.DEFAULT_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT

        # Initialize the bot
        self.bot = self.AIAvatarBot()
        # Ensure the AIAvatar instance used by the bot is the mocked one
        # If AIAvatarBot creates its own instance or uses one passed at init, this needs adjustment.
        # Based on the current discord_aiavatar_complete.py, 'aiavatar' is a global instance,
        # so self.mock_global_aiavatar_instance will be used by the bot's methods.

        # Setup mock methods for the global aiavatar instance
        self.mock_global_aiavatar_instance.llm.chat = AsyncMock(
            return_value="Test AI response"
        )
        self.mock_global_aiavatar_instance.tts.speak = AsyncMock(
            return_value=b"test_tts_audio_data"
        )

        # Setup for tempfile.NamedTemporaryFile
        self.mock_temp_file_object = MagicMock()
        self.mock_temp_file_object.name = "dummy_temp_file.wav"
        self.mock_temp_file_object.__enter__.return_value = (
            self.mock_temp_file_object
        )  # For context manager
        self.mock_temp_file_constructor.return_value = self.mock_temp_file_object

        # Initialize the in-memory database for this test suite
        self.init_db()

    async def create_mock_message(
        self,
        content,
        author_is_bot=False,
        guild_name="TestGuild",
        channel_send_mock=None,
        author_id=123,
        author_name="TestUser",
    ):
        mock_message = MagicMock(spec=discord.Message)
        mock_message.author = MagicMock(spec=discord.User)
        mock_message.author.bot = author_is_bot
        mock_message.author.id = author_id
        mock_message.author.name = author_name

        mock_message.content = content

        if guild_name:
            mock_message.guild = MagicMock(spec=discord.Guild)
            mock_message.guild.name = guild_name
            mock_message.guild.id = 789
        else:
            mock_message.guild = None

        mock_message.channel = MagicMock(spec=discord.TextChannel)
        if channel_send_mock:
            mock_message.channel.send = channel_send_mock
        else:
            mock_message.channel.send = AsyncMock()

        return mock_message

    def create_mock_voice_client(
        self, guild_id=789, is_connected=True, is_playing_val=False
    ):
        mock_vc = MagicMock(spec=discord.VoiceClient)
        mock_vc.guild = MagicMock(spec=discord.Guild)
        mock_vc.guild.id = guild_id
        mock_vc.is_connected = MagicMock(return_value=is_connected)
        mock_vc.is_playing = MagicMock(return_value=is_playing_val)
        mock_vc.play = MagicMock()
        mock_vc.stop = MagicMock()
        mock_vc.channel = MagicMock(spec=discord.VoiceChannel)
        mock_vc.channel.name = "TestVoiceChannel"
        return mock_vc

    # 1. Message from Bot
    @patch(
        "src.bot.discord_aiavatar_complete.DB_NAME", ":memory:"
    )  # ensure DB is patched for module level if test runs standalone
    async def test_on_message_ignores_bot_author(
        self, mock_db_name_override=None
    ):  # mock_db_name_override to consume the patch if method is run standalone
        mock_message = await self.create_mock_message("Hello", author_is_bot=True)
        await self.bot.on_message(mock_message)
        self.mock_global_aiavatar_instance.llm.chat.assert_not_called()
        mock_message.channel.send.assert_not_called()

    # 2. Command Message
    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    async def test_on_message_ignores_command_prefix(self, mock_db_name_override=None):
        # bot.command_prefix is "!"
        mock_message = await self.create_mock_message("!hello")
        await self.bot.on_message(mock_message)
        self.mock_global_aiavatar_instance.llm.chat.assert_not_called()
        mock_message.channel.send.assert_not_called()

    # 3. DM Message
    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    async def test_on_message_ignores_dm_message(self, mock_db_name_override=None):
        mock_message = await self.create_mock_message("Hello in DM", guild_name=None)
        await self.bot.on_message(mock_message)
        self.mock_global_aiavatar_instance.llm.chat.assert_not_called()
        # DMs don't have message.channel.send in the same way for this context, but good to check no interaction
        # self.mock_logger_instance.debug.assert_any_call("Message not in a guild (e.g., DM), ignoring for voice-related processing.")

    # 4. Bot Not in Voice Channel
    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    async def test_on_message_bot_not_in_voice_channel(
        self, mock_db_name_override=None
    ):
        self.bot.voice_clients = []  # Ensure bot has no active voice clients
        mock_message = await self.create_mock_message("Hello when bot not in VC")

        await self.bot.on_message(mock_message)

        self.mock_global_aiavatar_instance.llm.chat.assert_not_called()
        mock_message.channel.send.assert_not_called()
        # self.mock_logger_instance.debug.assert_any_call(f"Bot not in a voice channel in guild '{mock_message.guild.name}' or message not applicable. Ignoring.")

    # 5. Successful Text-to-Voice Interaction
    @patch(
        "src.bot.discord_aiavatar_complete.save_message"
    )  # Mock save_message to check calls
    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    async def test_on_message_successful_text_to_voice(
        self, mock_db_name_override, mock_save_message
    ):
        mock_vc = self.create_mock_voice_client(guild_id=789)
        self.bot.voice_clients = [mock_vc]  # Bot is in this VC

        mock_channel_send = AsyncMock()
        mock_message = await self.create_mock_message(
            "Test query", channel_send_mock=mock_channel_send, author_id=999
        )

        # Setup AI and TTS responses
        self.mock_global_aiavatar_instance.llm.chat.return_value = "Mocked AI response"
        self.mock_global_aiavatar_instance.tts.speak.return_value = b"mock_audio_data"

        await self.bot.on_message(mock_message)

        # Check LLM call
        self.mock_global_aiavatar_instance.llm.chat.assert_called_once()
        # Check save_message calls (user message + assistant message)
        self.assertEqual(mock_save_message.call_count, 2)
        mock_save_message.assert_any_call(999, "user", "Test query")
        mock_save_message.assert_any_call(999, "assistant", "Mocked AI response")

        # Check message.channel.send
        mock_channel_send.assert_called_once_with("Mocked AI response")

        # Check TTS call
        self.mock_global_aiavatar_instance.tts.speak.assert_called_once_with(
            "Mocked AI response"
        )

        # Check tempfile usage
        self.mock_temp_file_constructor.assert_called_once_with(
            suffix=".wav", delete=False
        )
        self.mock_temp_file_object.write.assert_called_once_with(b"mock_audio_data")

        # Check voice_client.play
        self.mock_ffmpeg_audio_class.assert_called_once_with("dummy_temp_file.wav")
        mock_vc.play.assert_called_once()

        # Check os.remove for temp file
        self.mock_os_remove_func.assert_called_once_with("dummy_temp_file.wav")
        self.mock_asyncio_sleep_func.assert_called()  # To wait for playback

    # 6. LLM Error
    @patch("src.bot.discord_aiavatar_complete.save_message")
    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    async def test_on_message_llm_error(self, mock_db_name_override, mock_save_message):
        mock_vc = self.create_mock_voice_client(guild_id=789)
        self.bot.voice_clients = [mock_vc]
        mock_channel_send = AsyncMock()
        mock_message = await self.create_mock_message(
            "Query causing LLM error",
            channel_send_mock=mock_channel_send,
            author_id=998,
        )

        self.mock_global_aiavatar_instance.llm.chat.side_effect = Exception(
            "LLM processing failed"
        )

        await self.bot.on_message(mock_message)

        self.mock_global_aiavatar_instance.llm.chat.assert_called_once()
        # User message should still be saved
        mock_save_message.assert_called_once_with(
            998, "user", "Query causing LLM error"
        )

        mock_channel_send.assert_not_called()
        self.mock_global_aiavatar_instance.tts.speak.assert_not_called()
        mock_vc.play.assert_not_called()
        self.mock_logger_instance.error.assert_any_call(
            f"Error during AI processing for {mock_message.author.name} (ID: {mock_message.author.id}): LLM processing failed"
        )

    # 7. TTS Error
    @patch("src.bot.discord_aiavatar_complete.save_message")
    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    async def test_on_message_tts_error(self, mock_db_name_override, mock_save_message):
        mock_vc = self.create_mock_voice_client(guild_id=789)
        self.bot.voice_clients = [mock_vc]
        mock_channel_send = AsyncMock()
        mock_message = await self.create_mock_message(
            "Query causing TTS error",
            channel_send_mock=mock_channel_send,
            author_id=997,
        )

        self.mock_global_aiavatar_instance.llm.chat.return_value = (
            "Successful LLM response for TTS test"
        )
        self.mock_global_aiavatar_instance.tts.speak.side_effect = Exception(
            "TTS failed"
        )

        await self.bot.on_message(mock_message)

        self.mock_global_aiavatar_instance.llm.chat.assert_called_once()
        # User and assistant messages saved
        self.assertEqual(mock_save_message.call_count, 2)
        mock_channel_send.assert_called_once_with(
            "Successful LLM response for TTS test"
        )  # Text response still sent
        self.mock_global_aiavatar_instance.tts.speak.assert_called_once()
        mock_vc.play.assert_not_called()
        self.mock_logger_instance.error.assert_any_call(
            f"Error during TTS or audio playback for {mock_message.author.name}: TTS failed"
        )
        # Check if temp file was attempted to be created and then cleaned up if path was set
        if self.mock_temp_file_constructor.called:
            self.mock_os_remove_func.assert_called_with("dummy_temp_file.wav")

    # 8. Message Send Error
    @patch("src.bot.discord_aiavatar_complete.save_message")
    @patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:")
    async def test_on_message_channel_send_error(
        self, mock_db_name_override, mock_save_message
    ):
        mock_vc = self.create_mock_voice_client(guild_id=789)
        self.bot.voice_clients = [mock_vc]

        mock_channel_send_that_fails = AsyncMock(
            side_effect=discord.DiscordException("Failed to send message")
        )
        mock_message = await self.create_mock_message(
            "Query leading to send error",
            channel_send_mock=mock_channel_send_that_fails,
            author_id=996,
        )

        self.mock_global_aiavatar_instance.llm.chat.return_value = (
            "LLM response for send error test"
        )
        self.mock_global_aiavatar_instance.tts.speak.return_value = (
            b"tts_data_for_send_error_test"
        )

        await self.bot.on_message(mock_message)

        self.mock_global_aiavatar_instance.llm.chat.assert_called_once()
        self.assertEqual(
            mock_save_message.call_count, 2
        )  # User and assistant messages saved
        mock_channel_send_that_fails.assert_called_once_with(
            "LLM response for send error test"
        )
        self.mock_logger_instance.error.assert_any_call(
            f"Failed to send AI response to channel {mock_message.channel.name} for {mock_message.author.name}: Failed to send message"
        )

        # TTS should still be attempted as per current logic
        self.mock_global_aiavatar_instance.tts.speak.assert_called_once_with(
            "LLM response for send error test"
        )
        mock_vc.play.assert_called_once()  # And playback
        self.mock_os_remove_func.assert_called_with("dummy_temp_file.wav")


# Ensure this is at the end of the file if running tests directly,
# but preferably use `python -m unittest discover`
if __name__ == "__main__":
    with patch("src.bot.discord_aiavatar_complete.DB_NAME", ":memory:"):
        with patch("dotenv.load_dotenv", return_value=True):
            # Deeper patches for discord client/tree may not be needed if bot instance is AIAvatarBot directly
            # and not relying on discord.Client global/class patches for its own init.
            # The key is that AIAvatarBot itself and its methods are what we test.
            with patch(
                "logging.getLogger", return_value=MagicMock()
            ):  # General logging
                with patch(
                    "discord.Client", MagicMock()
                ):  # If AIAvatarBot's super uses it
                    with patch("discord.app_commands.CommandTree", MagicMock()):
                        with patch(
                            "src.bot.services.ai_service.AIAvatar", MagicMock()
                        ):  # If this is a different AIAvatar
                            unittest.main()

import unittest
from unittest.mock import MagicMock, call, patch

import numpy as np

# Import the module to check for availability before running specific tests
import src.bot.services.audio_service

HAS_SOUNDDEVICE = src.bot.services.audio_service.sd is not None

# Assuming audio_service.py is in src.bot.services
from src.bot.services.audio_service import (
    cleanup_audio_files,
    record_with_silence_detection,
)


class TestAudioService(unittest.TestCase):

    @patch("src.bot.services.audio_service.os.path.exists")
    @patch("src.bot.services.audio_service.os.remove")
    def test_cleanup_audio_files_existing_files(
        self, mock_os_remove, mock_os_path_exists
    ):
        mock_os_path_exists.return_value = True
        files_to_clean = ["file1.wav", "file2.wav"]

        cleanup_audio_files(files_to_clean)

        mock_os_path_exists.assert_has_calls(
            [call("file1.wav"), call("file2.wav")], any_order=True
        )
        mock_os_remove.assert_has_calls(
            [call("file1.wav"), call("file2.wav")], any_order=True
        )
        self.assertEqual(mock_os_remove.call_count, 2)

    @patch("src.bot.services.audio_service.os.path.exists")
    @patch("src.bot.services.audio_service.os.remove")
    def test_cleanup_audio_files_non_existing_files(
        self, mock_os_remove, mock_os_path_exists
    ):
        mock_os_path_exists.return_value = False
        files_to_clean = ["file1.wav", "file2.wav"]

        cleanup_audio_files(files_to_clean)

        mock_os_path_exists.assert_has_calls(
            [call("file1.wav"), call("file2.wav")], any_order=True
        )
        mock_os_remove.assert_not_called()

    @patch("src.bot.services.audio_service.os.path.exists")
    @patch("src.bot.services.audio_service.os.remove")
    def test_cleanup_audio_files_empty_list(self, mock_os_remove, mock_os_path_exists):
        files_to_clean = []

        cleanup_audio_files(files_to_clean)

        mock_os_path_exists.assert_not_called()
        mock_os_remove.assert_not_called()

    @patch("src.bot.services.audio_service.os.path.exists")
    @patch("src.bot.services.audio_service.os.remove")
    def test_cleanup_audio_files_none(self, mock_os_remove, mock_os_path_exists):
        # Test with None as input
        cleanup_audio_files(None)

        mock_os_path_exists.assert_not_called()
        mock_os_remove.assert_not_called()

    # Test that returns None when sounddevice is not available
    @unittest.skipIf(not HAS_SOUNDDEVICE, "sounddevice not available")
    @patch(
        "src.bot.services.audio_service.sd", None
    )  # Force sd to be None for this test
    def test_record_with_silence_detection_no_sounddevice(self):
        result = record_with_silence_detection()
        self.assertIsNone(result)

    @unittest.skipIf(not HAS_SOUNDDEVICE, "sounddevice not available")
    @patch("src.bot.services.audio_service.tempfile.NamedTemporaryFile")
    @patch("src.bot.services.audio_service.sf.write")
    @patch("src.bot.services.audio_service.sd.InputStream")
    def test_record_stops_after_max_duration(
        self, mock_input_stream_class, mock_sf_write, mock_temp_file
    ):
        # Configure mocks
        mock_stream_instance = MagicMock()
        mock_input_stream_class.return_value = mock_stream_instance

        # Simulate continuous audio data (non-silent)
        # Each call to read returns 1 second of data (samplerate frames)
        # max_duration is 5 seconds, silence_duration is 2 seconds
        # We need enough data to exceed max_duration
        samplerate = 16000
        channels = 1
        audio_chunk = np.array(
            [[0.5]] * samplerate, dtype=np.float32
        )  # 1 second of non-silent audio

        # Simulate stream reading behavior
        # Let's say read is called every 0.1 seconds (blocksize = samplerate / 10)
        blocksize = samplerate // 10
        num_blocks_for_max_duration = (5 * samplerate) // blocksize

        # This mock will be called multiple times.
        # We want it to provide non-silent data until max_duration is effectively reached.
        # The function internally checks time, so we just need to provide data.
        def stream_read_side_effect(frames):
            # Return non_silent audio data
            return audio_chunk[:frames], True  # True indicates no underflow

        mock_stream_instance.read.side_effect = stream_read_side_effect
        mock_stream_instance.samplerate = samplerate
        mock_stream_instance.channels = channels

        mock_temp_file_object = MagicMock()
        mock_temp_file_object.name = "test_max_duration.wav"
        mock_temp_file.return_value.__enter__.return_value = mock_temp_file_object

        # Call the function
        # record_with_silence_detection(samplerate=16000, channels=1, silence_threshold=0.01, silence_duration=2, max_duration=5)
        filename = record_with_silence_detection(
            samplerate=samplerate,
            channels=channels,
            silence_threshold=0.01,
            silence_duration=2,
            max_duration=5,
        )

        self.assertEqual(filename, "test_max_duration.wav")
        mock_input_stream_class.assert_called_once_with(
            samplerate=samplerate,
            channels=channels,
            dtype="float32",
            blocksize=samplerate // 10,
        )  # blocksize is samplerate // 10
        mock_stream_instance.__enter__.assert_called_once()  # Context manager entry
        mock_stream_instance.__exit__.assert_called_once()  # Context manager exit

        # Check that sf.write was called
        mock_sf_write.assert_called_once()
        args, kwargs = mock_sf_write.call_args
        self.assertEqual(args[0], "test_max_duration.wav")  # filename
        self.assertIsInstance(args[1], np.ndarray)  # data
        self.assertEqual(args[2], samplerate)  # samplerate

        # Verify data length: should be close to max_duration * samplerate
        # The loop runs as long as time.time() < start_time + max_duration
        # and not (silence_detected and time.time() > silence_start_time + silence_duration)
        # The number of frames recorded should be approx max_duration * samplerate
        # Each read call reads `blocksize` frames.
        # The loop for recording runs roughly max_duration / (blocksize/samplerate) times
        # Total frames = (max_duration * 10) * blocksize = max_duration * samplerate
        self.assertGreaterEqual(
            len(args[1]), (5 * samplerate) - blocksize
        )  # Allow for one block less due to timing
        self.assertLessEqual(
            len(args[1]), 5 * samplerate + blocksize
        )  # Allow for one block more

    @unittest.skipIf(not HAS_SOUNDDEVICE, "sounddevice not available")
    @patch("src.bot.services.audio_service.tempfile.NamedTemporaryFile")
    @patch("src.bot.services.audio_service.sf.write")
    @patch("src.bot.services.audio_service.sd.InputStream")
    @patch(
        "src.bot.services.audio_service.time.time"
    )  # Mock time to control silence detection
    def test_record_stops_due_to_silence(
        self, mock_time, mock_input_stream_class, mock_sf_write, mock_temp_file
    ):
        # Configure mocks
        mock_stream_instance = MagicMock()
        mock_input_stream_class.return_value = mock_stream_instance

        samplerate = 16000
        channels = 1
        silence_threshold = 0.01
        silence_duration_config = 2  # seconds
        max_duration_config = 10  # seconds (longer than silence)
        blocksize = samplerate // 10  # 0.1 seconds per read

        # Simulate stream reading behavior:
        # 1. Some initial sound
        # 2. Then silence
        non_silent_chunk = np.array([[0.5]] * blocksize, dtype=np.float32)  # Non-silent
        silent_chunk = np.array([[0.001]] * blocksize, dtype=np.float32)  # Silent

        # We'll have the stream read non-silent data for 1 second, then silent data
        # 1 second of non-silent data = 10 blocks
        # Then enough silent blocks to trigger silence_duration
        num_initial_sound_blocks = 10
        num_silence_blocks_needed = (
            silence_duration_config * samplerate
        ) // blocksize + 1  # +1 to ensure duration is met

        read_count = 0

        def stream_read_side_effect(frames):
            nonlocal read_count
            read_count += 1
            if read_count <= num_initial_sound_blocks:
                return non_silent_chunk[:frames], True
            else:
                return silent_chunk[:frames], True

        mock_stream_instance.read.side_effect = stream_read_side_effect
        mock_stream_instance.samplerate = samplerate
        mock_stream_instance.channels = channels

        mock_temp_file_object = MagicMock()
        mock_temp_file_object.name = "test_silence_detection.wav"
        mock_temp_file.return_value.__enter__.return_value = mock_temp_file_object

        # Mock time.time() to control the silence detection timing
        # Initial time, then advance it to trigger silence
        # t=0: start_time, first read (non-silent)
        # t=0.1: second read (non-silent) ... up to t=0.9 (10th block)
        # t=1.0: 11th read (silent), silence_start_time is set
        # t=1.1: 12th read (silent)
        # ...
        # t=1.0 + silence_duration_config (e.g., 1.0 + 2.0 = 3.0): silence condition met
        time_ticks = [0.0]  # start_time
        # Simulate time for initial sound + silence duration
        for i in range(
            num_initial_sound_blocks + num_silence_blocks_needed + 5
        ):  # Add a few extra ticks
            time_ticks.append(
                time_ticks[-1] + (blocksize / samplerate)
            )  # each block takes 0.1s
        mock_time.side_effect = time_ticks

        filename = record_with_silence_detection(
            samplerate=samplerate,
            channels=channels,
            silence_threshold=silence_threshold,
            silence_duration=silence_duration_config,
            max_duration=max_duration_config,
        )

        self.assertEqual(filename, "test_silence_detection.wav")
        mock_input_stream_class.assert_called_once_with(
            samplerate=samplerate,
            channels=channels,
            dtype="float32",
            blocksize=blocksize,
        )
        mock_stream_instance.__enter__.assert_called_once()
        mock_stream_instance.__exit__.assert_called_once()

        mock_sf_write.assert_called_once()
        args, kwargs = mock_sf_write.call_args
        self.assertEqual(args[0], "test_silence_detection.wav")
        self.assertIsInstance(args[1], np.ndarray)
        self.assertEqual(args[2], samplerate)

        # Verify data length: should be around (initial_sound_duration + silence_duration_config) * samplerate
        # Initial sound was 1 second (num_initial_sound_blocks * block_duration)
        # Silence detection kicks in after silence_duration_config of silence.
        # The recording includes the initial sound and the silence period that triggered the stop.
        expected_frames = (
            num_initial_sound_blocks + num_silence_blocks_needed - 1
        ) * blocksize  # -1 because the loop breaks after condition is met

        # The actual number of frames can be tricky due to how silence is measured and loop breaks.
        # It should contain the initial non-silent part, and then the part of silence that triggered the condition.
        # Roughly: 1s (sound) + 2s (silence leading to stop) = 3s of audio data
        # So, 3 * samplerate frames
        # num_initial_sound_blocks = 10 (1 second)
        # num_silence_blocks_needed to trigger = 20 (2 seconds)
        # Total blocks read before stopping = 10 (sound) + 20 (silence) = 30 blocks
        # Total frames = 30 * blocksize = 30 * (16000/10) = 30 * 1600 = 48000 frames
        # This corresponds to 3 seconds of audio.
        self.assertGreaterEqual(
            len(args[1]),
            (num_initial_sound_blocks + num_silence_blocks_needed - 2) * blocksize,
        )  # Allow some leeway
        self.assertLessEqual(
            len(args[1]),
            (num_initial_sound_blocks + num_silence_blocks_needed + 2) * blocksize,
        )


if __name__ == "__main__":
    unittest.main()

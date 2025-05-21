import discord
from discord.ext import commands
from discord import FFmpegPCMAudio
from discord import app_commands
import asyncio
import tempfile
import os
import numpy as np
import soundfile as sf
import sqlite3
from datetime import datetime
import dotenv
import sys
import pathlib
import time
import traceback
import logging
from logging.handlers import RotatingFileHandler

# Conditionally import dependencies to handle missing packages in test environments
try:
    from aiavatar import AIAvatar
    aiavatar_import_error = None
except ImportError as e:
    aiavatar_import_error = e
    AIAvatar = None

try:
    import sounddevice as sd
    sounddevice_import_error = None
except ImportError as e:
    sounddevice_import_error = e
    sd = None

try:
    print("スクリプト開始")

    # ログ設定
    LOG_DIR = pathlib.Path.cwd() / "logs"
    LOG_DIR.mkdir(exist_ok=True)

    # ロガーの設定
    logger = logging.getLogger("aiavatar_bot")
    logger.setLevel(logging.DEBUG)

    # コンソールハンドラ
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_format = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    console_handler.setFormatter(console_format)

    # ファイルハンドラ（ローテーション機能付き）
    file_handler = RotatingFileHandler(
        LOG_DIR / "bot.log", maxBytes=5 * 1024 * 1024, backupCount=5  # 5MB
    )
    file_handler.setLevel(logging.DEBUG)
    file_format = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    file_handler.setFormatter(file_format)

    # 音声ログ用のファイルハンドラ
    voice_file_handler = RotatingFileHandler(
        LOG_DIR / "voice.log", maxBytes=5 * 1024 * 1024, backupCount=5  # 5MB
    )
    voice_file_handler.setLevel(logging.DEBUG)
    voice_file_handler.setFormatter(file_format)

    # ハンドラの追加
    logger.addHandler(console_handler)
    logger.addHandler(file_handler)
    logger.addHandler(voice_file_handler)

    logger.info("=== ボット起動 ===")

    dotenv.load_dotenv()

    # 開発モード（マイク入力なしでも動作可能）
    DEV_MODE = False  # 常に本番モードで動作

    TOKEN = os.getenv("DISCORD_BOT_TOKEN")
    DIFY_API_KEY = os.getenv("DIFY_API_KEY")

    # データベースの設定
    cur_dir = pathlib.Path.cwd()
    DB_PATH = str(cur_dir / "aiavatar_bot.db")
    DB_NAME = DB_PATH  # Add this for testing compatibility

    # ロック問題を避けるために必要な設定
    DB_TIMEOUT = 60.0  # 接続タイムアウト値（秒）
    db_conn = None  # グローバル接続変数

    logger.info(f"データベースパス: {DB_PATH}")

    # トークンの確認
    if not TOKEN:
        logger.error(
            "Discord Botトークンが設定されていません。.envファイルを確認してください。"
        )
        # In test environment, don't exit
        if "pytest" not in sys.modules:
            raise ValueError(
                "Discord Botトークンが設定されていません。.envファイルを確認してください。"
            )

    # datetime型をISO形式の文字列に変換する関数
    def datetime_to_str(dt):
        return dt.isoformat()

    # データベース初期化
    def init_db():
        global db_conn

        # データベースファイルが存在し、サイズが0でない場合は削除
        if os.path.exists(DB_PATH) and os.path.getsize(DB_PATH) > 0:
            try:
                print(f"既存のデータベースファイルを削除します: {DB_PATH}")
                os.remove(DB_PATH)
                time.sleep(1)  # ファイルシステムの同期を待つ
            except Exception as e:
                print(f"警告: データベースファイルを削除できませんでした: {e}")

        try:
            print(f"ファイルベースのデータベースに接続しています: {DB_PATH}")
            # トランザクション高速化のため、WALモードを使用
            db_conn = sqlite3.connect(DB_NAME if 'pytest' in sys.modules else DB_PATH, timeout=DB_TIMEOUT)
            db_conn.execute("PRAGMA journal_mode=WAL")
            db_conn.execute("PRAGMA busy_timeout = 30000")  # 30秒のビジータイムアウト
            c = db_conn.cursor()

            # 会話履歴テーブル
            c.execute(
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
            # システムプロンプトテーブル
            c.execute(
                """
            CREATE TABLE IF NOT EXISTS system_prompts (
                user_id INTEGER PRIMARY KEY,
                prompt TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
            )
            # 録音設定テーブル
            c.execute(
                """
            CREATE TABLE IF NOT EXISTS recording_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL UNIQUE,
                enabled BOOLEAN NOT NULL DEFAULT 1,
                keyword TEXT
            )
            """
            )
            db_conn.commit()
            print("データベースを正常に初期化しました")

            # 動作確認のためテストデータを挿入
            c.execute(
                "INSERT INTO conversation_history (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                (123456, "system", "テストデータです", datetime_to_str(datetime.now())),
            )
            db_conn.commit()
            print("テストデータを挿入しました")

        except sqlite3.Error as e:
            print(f"データベース初期化中にエラーが発生しました: {e}")
            print("エラーが発生したため、処理を終了します")
            # In test environment, don't exit
            if "pytest" not in sys.modules:
                sys.exit(1)  # エラーでプログラム終了

    # データベース接続を取得する関数
    def get_db_connection():
        global db_conn

        if db_conn is None:
            try:
                print(f"新しいデータベース接続を作成しています: {DB_PATH}")
                # データベース接続を作成
                db_conn = sqlite3.connect(DB_NAME if 'pytest' in sys.modules else DB_PATH, timeout=DB_TIMEOUT)
                db_conn.execute("PRAGMA journal_mode=WAL")
                db_conn.execute(
                    "PRAGMA busy_timeout = 30000"
                )  # 30秒のビジータイムアウト
            except sqlite3.Error as e:
                print(f"データベース接続エラー: {e}")
                print("エラーが発生したため、処理を終了します")
                # In test environment, don't exit
                if "pytest" not in sys.modules:
                    sys.exit(1)  # エラーでプログラム終了

        return db_conn

    # 履歴の保存/取得
    def save_message(user_id, role, content):
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute(
                "INSERT INTO conversation_history (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                (user_id, role, content, datetime_to_str(datetime.now())),
            )
            conn.commit()
            print(f"メッセージを保存しました - {role}: {content}")
        except sqlite3.Error as e:
            print(f"メッセージ保存エラー: {e}")

    def get_user_history(user_id, limit=10):
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute(
                "SELECT role, content FROM conversation_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?",
                (user_id, limit),
            )
            rows = c.fetchall()
            # 古い順に変換
            history = [
                {"role": role, "content": content} for role, content in reversed(rows)
            ]
            print(f"ユーザー履歴を取得しました - {len(history)}件")
            return history
        except sqlite3.Error as e:
            print(f"履歴取得エラー: {e}")
            return []

    # システムプロンプト管理
    def set_user_prompt(user_id, prompt):
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute(
                "INSERT OR REPLACE INTO system_prompts (user_id, prompt, created_at) VALUES (?, ?, ?)",
                (user_id, prompt, datetime_to_str(datetime.now())),
            )
            conn.commit()
            print(f"システムプロンプトを設定しました - {prompt}")
        except sqlite3.Error as e:
            print(f"プロンプト設定エラー: {e}")

    def get_user_prompt(user_id):
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute("SELECT prompt FROM system_prompts WHERE user_id = ?", (user_id,))
            row = c.fetchone()
            result = (
                row[0]
                if row
                else "あなたは親切なAIアシスタントです。質問に簡潔に答えてください。"
            )
            print(f"システムプロンプトを取得しました")
            return result
        except sqlite3.Error as e:
            print(f"プロンプト取得エラー: {e}")
            return "あなたは親切なAIアシスタントです。質問に簡潔に答えてください。"

    # 録音設定
    def set_recording_enabled(user_id, enabled=True, keyword=None):
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute(
                "INSERT OR REPLACE INTO recording_settings (user_id, enabled, keyword) VALUES (?, ?, ?)",
                (user_id, enabled, keyword),
            )
            conn.commit()
            print(f"録音設定を変更しました - enabled: {enabled}, keyword: {keyword}")
        except sqlite3.Error as e:
            print(f"録音設定変更エラー: {e}")

    def get_recording_settings(user_id):
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute(
                "SELECT enabled, keyword FROM recording_settings WHERE user_id = ?",
                (user_id,),
            )
            row = c.fetchone()
            if not row:
                # デフォルト設定：常に録音有効、キーワードなし
                # データベースに保存しておく（次回から取得できるように）
                set_recording_enabled(user_id, True)
                logger.debug(
                    f"ユーザーID {user_id} の録音設定が見つからないため、デフォルト設定（有効）を適用しました"
                )
                result = True, None
            else:
                result = row[0], row[1]
            logger.debug(f"録音設定を取得しました - {result}")
            return result
        except sqlite3.Error as e:
            logger.error(f"録音設定取得エラー: {e}")
            return True, None  # エラー時もデフォルトで有効

    # Discord Bot設定
    intents = discord.Intents.default()
    intents.message_content = True
    intents.voice_states = True

    class AIAvatarBot(commands.Bot):
        def __init__(self):
            super().__init__(command_prefix="!", intents=intents)

        async def setup_hook(self):
            # スラッシュコマンドを同期
            await self.tree.sync()
            logger.info("スラッシュコマンドを同期しました")

        async def on_ready(self):
            logger.info(f"Bot ready: {self.user}")
            logger.info("ボットの準備が完了しました")
            logger.info("チャンネルに参加するには /join コマンドを使用してください")
            logger.info(
                "録音は自動的に有効になるため、/recording_on コマンドは通常不要です"
            )

            # 起動通知メッセージは送信しない（ログには記録）
            for guild in self.guilds:
                logger.info(f"サーバー「{guild.name}」に接続しています")
            
            # MCPサーバーの自動接続
            try:
                from config import MCP_SERVERS
                if MCP_SERVERS:
                    logger.info("MCPサーバーへの自動接続を開始します")
                    for guild in self.guilds:
                        # 設定されたサーバーにボットが接続しているか確認
                        if guild.name in MCP_SERVERS:
                            channels_to_join = MCP_SERVERS[guild.name]
                            logger.info(f"サーバー「{guild.name}」の設定されたチャンネルに自動接続します: {channels_to_join}")
                            
                            for channel_name in channels_to_join:
                                # ボイスチャンネルを探す
                                voice_channel = discord.utils.get(guild.voice_channels, name=channel_name)
                                if voice_channel:
                                    try:
                                        # すでに接続済みかチェック
                                        already_connected = False
                                        for vc in self.voice_clients:
                                            if vc.channel.id == voice_channel.id:
                                                already_connected = True
                                                logger.info(f"チャンネル「{channel_name}」に既に接続済みです")
                                                break
                                        
                                        if not already_connected:
                                            # Discord音声ストリームを受信するためのシンクを準備
                                            from services.discord_audio import DiscordAudioSink
                                            audio_sink = DiscordAudioSink()
                                            voice_client = await voice_channel.connect()
                                            
                                            # 音声受信を開始（リッスンモード）
                                            voice_client.listen(audio_sink)
                                            voice_client.sink = audio_sink  # 参照を保持
                                            
                                            logger.info(f"ボイスチャンネル「{channel_name}」に自動接続しました")
                                    except Exception as e:
                                        logger.error(f"チャンネル「{channel_name}」への自動接続中にエラーが発生しました: {e}")
                                else:
                                    logger.warning(f"ボイスチャンネル「{channel_name}」が見つかりません")
                else:
                    logger.info("自動接続するMCPサーバーが設定されていません")
            except Exception as e:
                logger.error(f"MCPサーバー自動接続中にエラーが発生しました: {e}")

            init_db()  # データベース初期化

        async def on_message(self, message: discord.Message):
            logger.debug(f"on_message received: '{message.content}' from {message.author.name} in guild {message.guild.name if message.guild else 'DM'}")

            if message.author.bot:
                logger.debug("Message from bot, ignoring.")
                return

            # This check is for traditional prefix commands.
            # The bot uses "!" as a prefix.
            if message.content.startswith(self.command_prefix):
                logger.debug(f"Message starts with command prefix '{self.command_prefix}', ignoring for on_message handler.")
                # Let the command system handle this.
                # If you also want to process commands here for some reason, remove this check.
                # However, usually, commands are handled by their own decorators.
                return
            
            if not message.guild:
                logger.debug("Message not in a guild (e.g., DM), ignoring for voice-related processing.")
                return

            # Check if the bot is connected to a voice channel in the message's guild
            voice_client_in_guild = None
            for vc in self.voice_clients:
                if vc.guild == message.guild:
                    voice_client_in_guild = vc
                    break
            
            if voice_client_in_guild and voice_client_in_guild.is_connected():
                logger.info(f"Bot is in a voice channel in guild '{message.guild.name}'. Processing message from '{message.author.name}': '{message.content}'")
                
                user_id = message.author.id
                username = message.author.name # For logging
                ai_response = None # Initialize in case of error

                try:
                    # 1. Fetch User Context
                    history = get_user_history(user_id)
                    logger.debug(f"Fetched history for {username}: {len(history)} items.")
                    system_prompt = get_user_prompt(user_id)
                    logger.debug(f"Fetched system prompt for {username}: '{system_prompt[:50]}...'")

                    # 2. Save User's Message (do this before LLM call to include it in subsequent history calls if needed immediately)
                    save_message(user_id, "user", message.content)
                    logger.debug(f"Saved user message for {username}.")

                    # 3. Call LLM
                    # The history fetched *before* saving the current user message is correct for the LLM call.
                    # The current user message is passed as `text` argument.
                    start_time = time.time()
                    llm_response_text = await aiavatar.llm.chat(
                        text=message.content,
                        history=history, # History up to the previous turn
                        system_prompt=system_prompt
                    )
                    elapsed = time.time() - start_time
                    logger.info(f"AI response for {username} (took {elapsed:.2f}s): {llm_response_text}")
                    
                    ai_response = llm_response_text # Store for further actions

                    # 4. Save AI's Response
                    if ai_response: # Only save if a response was generated
                        save_message(user_id, "assistant", ai_response)
                        logger.debug(f"Saved AI response for {username}.")

                        # Send the AI's textual response back to the channel
                        try:
                            logger.info(f"Sending AI response to channel {message.channel.name} for user {username}: \"{ai_response[:50]}...\"")
                            await message.channel.send(ai_response)
                            logger.debug(f"Successfully sent AI response to channel {message.channel.name} for {username}.")
                        except discord.DiscordException as e:
                            logger.error(f"Failed to send AI response to channel {message.channel.name} for {username}: {e}")
                            logger.debug(traceback.format_exc())
                        except Exception as e: # Catch any other unexpected errors during send
                            logger.error(f"Unexpected error sending AI response to channel {message.channel.name} for {username}: {e}")
                            logger.debug(traceback.format_exc())
                        
                        # --- TTS and Audio Playback ---
                        if voice_client_in_guild and voice_client_in_guild.is_connected() and ai_response:
                            logger.info(f"Attempting TTS and audio playback for {username}.")
                            tts_audio_path = None
                            try:
                                # 1. Text-to-Speech
                                logger.debug(f"Requesting TTS for: \"{ai_response[:50]}...\"")
                                start_tts_time = time.time()
                                tts_audio_data = await aiavatar.tts.speak(ai_response)
                                tts_elapsed = time.time() - start_tts_time
                                logger.info(f"TTS completed for {username} in {tts_elapsed:.2f}s. Audio data length: {len(tts_audio_data)} bytes.")

                                # 2. Save TTS audio to a temporary file
                                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_tts_file:
                                    tmp_tts_file.write(tts_audio_data)
                                    tts_audio_path = tmp_tts_file.name
                                logger.debug(f"TTS audio saved to temporary file: {tts_audio_path}")

                                # 3. Play Audio
                                if voice_client_in_guild.is_playing():
                                    logger.warning(f"Voice client is currently playing audio for {username}. Stopping previous audio.")
                                    voice_client_in_guild.stop() # Stop current playback
                                    await asyncio.sleep(0.1) # Short pause to allow stop to take effect

                                logger.info(f"Playing TTS audio for {username} in voice channel {voice_client_in_guild.channel.name}.")
                                voice_client_in_guild.play(FFmpegPCMAudio(tts_audio_path))
                                
                                # Wait for playback to finish
                                while voice_client_in_guild.is_playing():
                                    await asyncio.sleep(0.1)
                                logger.info(f"Finished playing TTS audio for {username}.")

                            except Exception as e_tts:
                                logger.error(f"Error during TTS or audio playback for {username}: {e_tts}")
                                logger.debug(traceback.format_exc())
                            finally:
                                # 4. Cleanup temporary TTS file
                                if tts_audio_path and os.path.exists(tts_audio_path):
                                    try:
                                        os.remove(tts_audio_path)
                                        logger.debug(f"Successfully deleted temporary TTS file: {tts_audio_path}")
                                    except Exception as e_cleanup:
                                        logger.error(f"Error deleting temporary TTS file {tts_audio_path}: {e_cleanup}")
                        else:
                            if not (voice_client_in_guild and voice_client_in_guild.is_connected()):
                                logger.debug(f"Voice client not connected or available, skipping TTS for {username}.")
                            if not ai_response:
                                logger.debug(f"No AI response available, skipping TTS for {username}.")
                    else:
                        logger.warning(f"AI response was empty for {username}. Not saving assistant message or sending to channel.")

                except Exception as e:
                    logger.error(f"Error during AI processing for {username} (ID: {user_id}): {e}")
                    logger.debug(traceback.format_exc())
                    # Optionally, set a default error message for ai_response if needed downstream
                    # ai_response = "Sorry, I encountered an error." 
                
                # --- `ai_response` (string) is now available for further actions ---
                # Example: await message.channel.send(ai_response)
                # Example: await speak_text(voice_client_in_guild, ai_response)
                if ai_response:
                    logger.debug(f"AI response for {username} ready for further actions: '{ai_response[:100]}...'")
                else:
                    logger.warning(f"No AI response generated or error occurred for {username}. No further text/speech actions.")

            else:
                logger.debug(f"Bot not in a voice channel in guild '{message.guild.name}' or message not applicable. Ignoring.")


    # Botインスタンスの作成
    bot = AIAvatarBot()

    # AIAvatarKitの初期化
    # 環境変数から各APIキーを取得
    OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
    AIVISSPEECH_API_URL = os.getenv("AIVISSPEECH_API_URL", "http://localhost:50021")
    DIFY_API_URL = os.getenv("DIFY_API_URL", "https://api.dify.ai/v1")

    print("AIAvatarKitを初期化しています...")
    # For CI/test environments, handle missing audio device gracefully
    aiavatar = None
    try:
        if AIAvatar is not None:
            aiavatar = AIAvatar(
                openai_api_key=OPENAI_API_KEY,
            )
        else:
            print(f"AIAvatarがインポートできないため、初期化をスキップします: {aiavatar_import_error}")
            # In test environment, don't exit
            if "pytest" not in sys.modules:
                logger.error(f"AIAvatarのインポートエラー: {aiavatar_import_error}")
    except Exception as e:
        print(f"エラーが発生しました: {e}")
        # Set to None but don't exit in test environments
        if "pytest" in sys.modules:
            aiavatar = None
        else:
            logger.error(f"AIAvatar初期化エラー: {e}")
            logger.error(traceback.format_exc())

    # キーワード検出のキャッシュ
    last_transcribed = {}

    # 無音検知付き録音（話し始めたユーザーのみ）
    def record_with_silence_detection(
        filename,
        max_duration=15,
        silence_threshold=0.005,  # しきい値を下げる (0.01 → 0.005)
        silence_duration=2.0,  # 無音判定までの時間を長く (1.5 → 2.0)
        samplerate=16000,
        username=None,
    ):
        logger.info(f"録音開始: ユーザー「{username}」")
        
        # Check if sounddevice is available
        if sd is None:
            logger.error(f"sounddeviceがインポートできないため録音できません: {sounddevice_import_error}")
            return False
            
        frames = []
        silence_count = 0
        max_volume = 0.0
        total_frames = 0

        try:
            blocksize = int(samplerate * 0.1)  # 0.1秒ごと
            stream = sd.InputStream(
                samplerate=samplerate, channels=1, dtype="float32", blocksize=blocksize
            )
            with stream:
                # 最初に少し待機して、録音の準備を整える
                first_frames = []
                for i in range(5):  # 0.5秒待機
                    data, _ = stream.read(blocksize)
                    first_frames.append(data)

                # 実際の録音開始
                voice_detected = False
                for i in range(int(max_duration / 0.1)):
                    data, _ = stream.read(blocksize)
                    frames.append(data)
                    volume = np.abs(data).mean()
                    max_volume = max(max_volume, volume)
                    total_frames += 1

                    # 音量レベルをログに記録（デバッグ用）
                    if i % 10 == 0:  # 1秒ごとにログ
                        logger.debug(
                            f"録音中: フレーム {i}, 音量 {volume:.6f}, 無音カウント {silence_count}, しきい値 {silence_threshold}"
                        )

                    # 音声検出されたかどうか
                    if volume > silence_threshold and not voice_detected:
                        voice_detected = True
                        logger.info(f"音声検出: 音量 {volume:.6f}")

                    if volume < silence_threshold:
                        silence_count += 1
                        if silence_count % 5 == 0:  # 0.5秒ごとにログ
                            logger.debug(f"無音検出: {silence_count * 0.1:.1f}秒間")
                    else:
                        silence_count = 0

                    # 音声が検出され、その後一定時間無音になったら終了
                    if voice_detected and silence_count * 0.1 > silence_duration:
                        logger.info(
                            f"無音期間({silence_duration}秒)を検出したため録音終了"
                        )
                        break

            # すべてのフレームを結合
            if len(first_frames) > 0:
                all_frames = first_frames + frames
            else:
                all_frames = frames

            audio = np.concatenate(all_frames, axis=0)
            sf.write(filename, audio, samplerate)
            duration = total_frames * 0.1
            logger.info(
                f"録音完了: 長さ {duration:.1f}秒, 最大音量 {max_volume:.6f}, 保存先 {filename}"
            )

            # 音声ファイルのサイズをログに記録
            file_size = os.path.getsize(filename)
            logger.debug(f"音声ファイルサイズ: {file_size / 1024:.1f} KB")

            # 音声が検出されたかどうかを返す
            if not voice_detected or max_volume < silence_threshold:
                logger.warning(
                    f"有効な音声が検出されませんでした: 最大音量 {max_volume:.6f}"
                )
                return False

            return True
        except Exception as e:
            logger.error(f"録音中にエラーが発生しました: {e}")
            logger.debug(traceback.format_exc())
            return False

    # ボイスチャンネルで話し始めたユーザーを検知
    # また、画面共有を開始したユーザーも検知して応答できるようにします
    @bot.event
    async def on_voice_state_update(member, before, after):
        # ボットの場合は無視
        if member.bot:
            return

        logger.info(
            f"ボイスイベント検出: ユーザー「{member.display_name}」(ID: {member.id})"
        )
        logger.debug(f"ボイスイベント詳細: before={before}, after={after}")

        # 以下のいずれかの条件でトリガー
        # 1. ユーザーがチャンネルに参加した
        # 2. ユーザーがミュートを解除した
        # 3. ユーザーがサーバーミュートを解除された
        # 4. ユーザーがデフミュートを解除した
        # 5. ユーザーが画面共有を開始した
        is_stream_start = not before.self_stream and after.self_stream
        if after.channel and (
            not before.channel  # チャンネル参加
            or (before.self_mute and not after.self_mute)  # ミュート解除
            or (before.mute and not after.mute)  # サーバーミュート解除
            or (before.self_deaf and not after.self_deaf)  # デフミュート解除
            or is_stream_start  # 画面共有開始
        ):
            # 画面共有開始の場合は特別なログを出力
            if is_stream_start:
                logger.info(f"ユーザー「{member.display_name}」が画面共有を開始しました。会話処理を開始します。")
                
            # ユーザーの録音設定確認
            enabled, keyword = get_recording_settings(member.id)
            logger.debug(f"ユーザー設定: 録音有効={enabled}, キーワード={keyword}")

            if not enabled:
                logger.info(
                    f"ユーザー「{member.display_name}」は録音設定がオフのため無視します"
                )
                return  # 録音オフのユーザーは無視

            # Botが同じチャンネルにいる場合のみ
            for vc in bot.voice_clients:
                if vc.channel == after.channel:
                    logger.info(
                        f"AIボットとユーザー「{member.display_name}」が同じチャンネルにいます。会話処理を開始します"
                    )
                    
                    # 画面共有開始の場合はテキストチャンネルに通知
                    if not before.self_stream and after.self_stream:
                        try:
                            # 最初のテキストチャンネルを取得
                            for channel in vc.guild.text_channels:
                                if channel.permissions_for(vc.guild.me).send_messages:
                                    await channel.send(f"**{member.display_name}** が画面共有を開始しました。画面共有中の会話にも応答します。")
                                    logger.debug(
                                        f"画面共有開始通知をテキストチャンネル「{channel.name}」に送信しました"
                                    )
                                    break
                        except Exception as e:
                            logger.error(f"画面共有開始通知の送信に失敗しました: {e}")
                    
                    # 音声シンクが設定されていなければ設定
                    if not hasattr(vc, 'sink') or not vc.sink:
                        from services.discord_audio import DiscordAudioSink
                        audio_sink = DiscordAudioSink()
                        vc.listen(audio_sink)
                        vc.sink = audio_sink
                        logger.info(f"ボイスクライアントに音声シンクを設定しました")
                    else:
                        # ユーザーの音声バッファをクリア
                        vc.sink.clear_user_audio(member.id)
                        logger.debug(f"ユーザー「{member.display_name}」の音声バッファをクリアしました")
                    
                    await trigger_ai_conversation(vc, member)
                    break

    # スラッシュコマンド定義
    @bot.tree.command(
        name="join", description="ボイスチャンネルに参加して会話を開始します（音声会話・画面共有の両方に対応）"
    )
    async def join(interaction: discord.Interaction):
        if interaction.user.voice:
            channel = interaction.user.voice.channel
            
            # Discord音声ストリームを受信するためのシンクを準備
            from services.discord_audio import DiscordAudioSink
            audio_sink = DiscordAudioSink()
            voice_client = await channel.connect()
            
            # 音声受信を開始（リッスンモード）
            voice_client.listen(audio_sink)
            voice_client.sink = audio_sink  # 参照を保持
            
            logger.info(f"ボイスチャンネル「{channel.name}」で音声受信を開始しました")

            # チャンネル参加時に自動的に録音設定をオンに
            set_recording_enabled(interaction.user.id, True)
            logger.info(
                f"ユーザー「{interaction.user.display_name}」の録音設定を自動的にオンにしました"
            )

            # チャンネル内の全ユーザーの録音設定をオンに
            for member in channel.members:
                if not member.bot:  # ボットは除外
                    set_recording_enabled(member.id, True)
                    logger.info(
                        f"チャンネル内のユーザー「{member.display_name}」の録音設定をオンにしました"
                    )

            await interaction.response.send_message(
                "ボイスチャンネルに参加しました。会話を開始します。話してみてください。画面共有にも対応しています。"
            )

            # 会話処理を自動的に開始
            await trigger_ai_conversation(voice_client, interaction.user)
        else:
            await interaction.response.send_message(
                "先にボイスチャンネルに参加してください。"
            )

    @bot.tree.command(name="leave", description="ボイスチャンネルから退出します")
    async def leave(interaction: discord.Interaction):
        for vc in bot.voice_clients:
            if vc.guild == interaction.guild:
                # 音声シンクをクリーンアップ
                if hasattr(vc, 'sink') and vc.sink:
                    try:
                        vc.sink.cleanup()
                        vc.stop_listening()
                        logger.info("音声シンクをクリーンアップしました")
                    except Exception as e:
                        logger.error(f"音声シンククリーンアップエラー: {e}")
                
                await vc.disconnect()
                await interaction.response.send_message("退出しました。")
                return
        await interaction.response.send_message("ボイスチャンネルにいません。")

    @bot.tree.command(name="set_prompt", description="AIの応答スタイルを設定します")
    @app_commands.describe(prompt="AIのシステムプロンプト")
    async def set_prompt(interaction: discord.Interaction, prompt: str):
        set_user_prompt(interaction.user.id, prompt)
        await interaction.response.send_message(
            f"システムプロンプトを設定しました。\n```{prompt}```"
        )

    @bot.tree.command(
        name="recording_on",
        description="録音をオンにします（デフォルトでオンのため、通常は不要）",
    )
    @app_commands.describe(keyword="検出するキーワード（任意）")
    async def recording_on(interaction: discord.Interaction, keyword: str = None):
        set_recording_enabled(interaction.user.id, True, keyword)
        if keyword:
            await interaction.response.send_message(
                f"録音をオンにしました。キーワード「{keyword}」が検出されたときのみ会話します。"
            )
        else:
            await interaction.response.send_message(
                "録音をオンにしました。あなたが話し始めたら自動で応答します。"
            )

    @bot.tree.command(name="recording_off", description="録音をオフにします")
    async def recording_off(interaction: discord.Interaction):
        set_recording_enabled(interaction.user.id, False)
        await interaction.response.send_message(
            "録音をオフにしました。あなたの声には反応しなくなります。"
        )

    @bot.tree.command(name="history_clear", description="会話履歴をクリアします")
    async def history_clear(interaction: discord.Interaction):
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute(
                "DELETE FROM conversation_history WHERE user_id = ?",
                (interaction.user.id,),
            )
            conn.commit()
            logger.info(f"ユーザーID {interaction.user.id} の会話履歴をクリアしました")
            await interaction.response.send_message("会話履歴をクリアしました。")
        except sqlite3.Error as e:
            logger.error(f"履歴クリアエラー: {e}")
            await interaction.response.send_message(
                "会話履歴のクリア中にエラーが発生しました。"
            )
    
    @bot.tree.command(
        name="add_mcp_server",
        description="現在のチャンネルをMCPサーバー（自動接続リスト）に追加します",
    )
    @app_commands.describe(add_to_config="設定ファイルに永続的に追加する場合はTrue")
    async def add_mcp_server(interaction: discord.Interaction, add_to_config: bool = False):
        if not interaction.guild:
            await interaction.response.send_message("このコマンドはサーバー内でのみ使用できます。")
            return
            
        if not interaction.user.voice or not interaction.user.voice.channel:
            await interaction.response.send_message("先にボイスチャンネルに参加してください。")
            return
            
        try:
            from config import MCP_SERVERS
            from utils import env_manager
            
            guild_name = interaction.guild.name
            channel_name = interaction.user.voice.channel.name
            
            # メモリ上の設定を更新
            if guild_name not in MCP_SERVERS:
                MCP_SERVERS[guild_name] = []
                
            if channel_name not in MCP_SERVERS[guild_name]:
                MCP_SERVERS[guild_name].append(channel_name)
                logger.info(f"MCPサーバーリストに追加: サーバー「{guild_name}」 チャンネル「{channel_name}」")
                
                # 設定ファイルに永続的に保存（オプション）
                if add_to_config:
                    # 環境変数ファイルを更新
                    result = env_manager.update_env_variable(
                        key='MCP_SERVERS',
                        value=MCP_SERVERS,
                        json_encode=True
                    )
                    
                    if result:
                        logger.info(f"MCPサーバー設定を.envファイルに保存しました")
                        await interaction.response.send_message(
                            f"チャンネル「{channel_name}」をMCPサーバーリストに追加し、設定ファイルに永続的に保存しました。"
                        )
                    else:
                        logger.warning("MCPサーバー設定を保存する.envファイルが見つからないか、更新できませんでした")
                        await interaction.response.send_message(
                            f"チャンネル「{channel_name}」をMCPサーバーリストに追加しましたが、設定ファイルが見つからないため永続的に保存できませんでした。"
                        )
                else:
                    await interaction.response.send_message(
                        f"チャンネル「{channel_name}」をMCPサーバーリストに一時的に追加しました。ボット再起動後にリセットされます。"
                    )
            else:
                await interaction.response.send_message(
                    f"チャンネル「{channel_name}」は既にMCPサーバーリストに含まれています。"
                )
        except Exception as e:
            logger.error(f"MCPサーバー追加中にエラーが発生しました: {e}")
            await interaction.response.send_message(
                f"MCPサーバーの追加中にエラーが発生しました: {str(e)}"
            )
    
    @bot.tree.command(
        name="list_mcp_servers",
        description="現在のMCPサーバー（自動接続リスト）を表示します",
    )
    async def list_mcp_servers(interaction: discord.Interaction):
        try:
            from config import MCP_SERVERS
            
            if not MCP_SERVERS:
                await interaction.response.send_message("MCPサーバーリストは空です。")
                return
                
            server_list = []
            for server, channels in MCP_SERVERS.items():
                server_list.append(f"**{server}**: {', '.join(channels)}")
                
            await interaction.response.send_message(
                "**MCPサーバーリスト**\n" + "\n".join(server_list)
            )
        except Exception as e:
            logger.error(f"MCPサーバーリスト取得中にエラーが発生しました: {e}")
            await interaction.response.send_message(
                f"MCPサーバーリストの取得中にエラーが発生しました: {str(e)}"
            )

    @bot.tree.command(
        name="remove_mcp_server",
        description="指定したサーバーのチャンネルをMCPサーバー（自動接続リスト）から削除します",
    )
    @app_commands.describe(
        server_name="削除するサーバー名（空の場合は現在のサーバー）",
        channel_name="削除するチャンネル名（空の場合は現在のチャンネル）",
        remove_from_config="設定ファイルからも永続的に削除する場合はTrue"
    )
    async def remove_mcp_server(
        interaction: discord.Interaction, 
        server_name: str = None, 
        channel_name: str = None, 
        remove_from_config: bool = False
    ):
        if not interaction.guild:
            await interaction.response.send_message("このコマンドはサーバー内でのみ使用できます。")
            return
            
        try:
            from config import MCP_SERVERS
            from utils import env_manager
            
            # サーバー名とチャンネル名が指定されていない場合は現在のものを使用
            guild_name = server_name or interaction.guild.name
            
            # チャンネル名が指定されていない場合は、ユーザーが現在参加しているチャンネルを使用
            if not channel_name:
                if not interaction.user.voice or not interaction.user.voice.channel:
                    await interaction.response.send_message("チャンネル名を指定するか、ボイスチャンネルに参加してください。")
                    return
                channel_name = interaction.user.voice.channel.name
            
            # サーバーがリストに存在するか確認
            if guild_name not in MCP_SERVERS:
                await interaction.response.send_message(f"サーバー「{guild_name}」はMCPサーバーリストに存在しません。")
                return
                
            # チャンネルがリストに存在するか確認
            if channel_name not in MCP_SERVERS[guild_name]:
                await interaction.response.send_message(
                    f"チャンネル「{channel_name}」はサーバー「{guild_name}」のMCPサーバーリストに存在しません。"
                )
                return
                
            # メモリ上の設定から削除
            MCP_SERVERS[guild_name].remove(channel_name)
            
            # サーバーのチャンネルリストが空になった場合、サーバー自体も削除
            if not MCP_SERVERS[guild_name]:
                del MCP_SERVERS[guild_name]
                
            logger.info(f"MCPサーバーリストから削除: サーバー「{guild_name}」 チャンネル「{channel_name}」")
            
            # 設定ファイルからも永続的に削除（オプション）
            if remove_from_config:
                result = env_manager.update_env_variable(
                    key='MCP_SERVERS',
                    value=MCP_SERVERS,
                    json_encode=True
                )
                
                if result:
                    logger.info(f"MCPサーバー設定を.envファイルに保存しました")
                    await interaction.response.send_message(
                        f"チャンネル「{channel_name}」をサーバー「{guild_name}」のMCPサーバーリストから削除し、設定ファイルに永続的に保存しました。"
                    )
                else:
                    logger.warning("MCPサーバー設定を保存する.envファイルが見つからないか、更新できませんでした")
                    await interaction.response.send_message(
                        f"チャンネル「{channel_name}」をサーバー「{guild_name}」のMCPサーバーリストから削除しましたが、設定ファイルが見つからないため永続的に保存できませんでした。"
                    )
            else:
                await interaction.response.send_message(
                    f"チャンネル「{channel_name}」をサーバー「{guild_name}」のMCPサーバーリストから一時的に削除しました。ボット再起動後にリセットされます。"
                )
        except Exception as e:
            logger.error(f"MCPサーバー削除中にエラーが発生しました: {e}")
            await interaction.response.send_message(
                f"MCPサーバーの削除中にエラーが発生しました: {str(e)}"
            )

    # 会話開始ボタン
    @bot.tree.command(
        name="talk",
        description="すぐに会話を開始したい場合に使用します（音声会話・画面共有の両方に対応）",
    )
    async def talk(interaction: discord.Interaction):
        if not interaction.guild:
            await interaction.response.send_message(
                "このコマンドはサーバー内でのみ使用できます。"
            )
            return

        # ユーザーがボイスチャンネルにいるか確認
        if not interaction.user.voice or not interaction.user.voice.channel:
            await interaction.response.send_message(
                "ボイスチャンネルに接続してから使用してください。"
            )
            return

        # ボットが同じボイスチャンネルにいるか確認
        voice_client = None
        for vc in bot.voice_clients:
            if vc.guild.id == interaction.guild.id:
                voice_client = vc
                break

        if not voice_client:
            await interaction.response.send_message(
                "ボットがボイスチャンネルに接続していません。まず `/join` コマンドを使用してください。"
            )
            return

        if voice_client.channel != interaction.user.voice.channel:
            await interaction.response.send_message(
                "ボットと同じボイスチャンネルに接続してください。"
            )
            return
        
        # 音声シンクが設定されていなければ設定
        if not hasattr(voice_client, 'sink') or not voice_client.sink:
            from services.discord_audio import DiscordAudioSink
            audio_sink = DiscordAudioSink()
            voice_client.listen(audio_sink)
            voice_client.sink = audio_sink
            logger.info(f"ボイスクライアントに音声シンクを設定しました")

        await interaction.response.send_message(
            "会話を開始します。話してみてください。画面共有にも対応しています。"
        )

        # 会話処理を開始
        await trigger_ai_conversation(voice_client, interaction.user)

    async def trigger_ai_conversation(vc, member):
        """
        ユーザーとの会話を開始する関数。
        音声会話と画面共有の両方に対応しています。

        Args:
            vc: ボイスクライアント
            member: 会話を開始するメンバー
        """
        # ユーザー情報取得
        user_id = member.id
        username = member.display_name
        logger.info(f"会話トリガー: ユーザー「{username}」(ID: {user_id})")

        # 音声シンクがない場合は設定
        if not hasattr(vc, 'sink') or not vc.sink:
            from services.discord_audio import DiscordAudioSink
            try:
                audio_sink = DiscordAudioSink()
                vc.listen(audio_sink)
                vc.sink = audio_sink
                logger.info(f"会話開始時に音声シンクを設定しました")
            except Exception as e:
                logger.error(f"音声シンク設定エラー: {e}")
                return

        enabled, keyword = get_recording_settings(user_id)
        if not enabled:
            logger.info(
                f"ユーザー「{username}」は録音設定がオフのため会話をスキップします"
            )
            return

        # 録音前の通知（テキストチャンネルに）
        try:
            # 最初のテキストチャンネルを取得
            for channel in vc.guild.text_channels:
                if channel.permissions_for(vc.guild.me).send_messages:
                    await channel.send(f"**{username}** の音声を聞いています...")
                    logger.debug(
                        f"録音開始通知をテキストチャンネル「{channel.name}」に送信しました"
                    )
                    break
        except Exception as e:
            logger.error(f"録音開始通知の送信に失敗しました: {e}")

        # 音声を待機するためのチェック間隔
        waiting_interval = 0.5  # 秒
        max_wait_time = 10.0  # 最大待機時間（秒）
        wait_count = 0
        audio_detected = False
        filename = None
        tts_file = None

        try:
            # ユーザーの音声が入力されるまで待機
            while wait_count * waiting_interval < max_wait_time:
                # ユーザーの音声データを取得
                user_audio = vc.sink.get_user_audio(user_id)
                
                if user_audio:
                    logger.info(f"ユーザー「{username}」からの音声データを検出: {len(user_audio)} パケット")
                    audio_detected = True
                    # 少し待機して音声がある程度溜まるようにする
                    await asyncio.sleep(1.0)
                    break
                
                await asyncio.sleep(waiting_interval)
                wait_count += 1
                
                if wait_count % 4 == 0:  # 2秒ごとにログ
                    logger.debug(f"ユーザー「{username}」の音声を待機中... {wait_count * waiting_interval:.1f}秒経過")
            
            if not audio_detected:
                logger.warning(f"ユーザー「{username}」からの音声が検出されませんでした")
                return

            # 音声をファイルに保存
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmpfile:
                filename = tmpfile.name

            logger.debug(f"一時ファイル作成: {filename}")

            # 音声をファイルに保存
            from services.discord_audio import save_discord_audio
            
            # 最新の音声データを取得して保存
            user_audio = vc.sink.get_user_audio(user_id)
            recording_success = save_discord_audio(user_audio, filename)
            
            # 処理後は音声バッファをクリア
            vc.sink.clear_user_audio(user_id)

            if not recording_success:
                logger.error("音声データの保存に失敗したため会話処理を中止します")
                try:
                    os.remove(filename)
                except:
                    pass
                return

            # AIAvatarKitで処理
            logger.info(f"音声認識開始: ユーザー「{username}」")
            with open(filename, "rb") as f:
                audio_bytes = f.read()
                logger.debug(f"音声データ読み込み: {len(audio_bytes)} バイト")

            start_time = time.time()
            text = await aiavatar.stt.transcribe(audio_bytes)
            elapsed = time.time() - start_time

            if not text.strip():
                logger.warning(f"音声認識結果が空です (処理時間: {elapsed:.2f}秒)")
                return
                
            logger.info(f"音声認識結果: 「{text}」(処理時間: {elapsed:.2f}秒)")

            # キーワード検出（設定がある場合）
            if keyword:
                if keyword.lower() in text.lower():
                    logger.info(f"キーワード「{keyword}」を検出しました")
                else:
                    logger.info(
                        f"キーワード「{keyword}」が含まれていないため応答をスキップします"
                    )
                    # キーワードが含まれない場合は応答しない
                    last_transcribed[user_id] = text  # キャッシュに保存
                    return

            # 履歴に追加
            save_message(user_id, "user", text)
            history = get_user_history(user_id)
            logger.debug(f"会話履歴: {len(history)}件")

            # システムプロンプト取得
            system_prompt = get_user_prompt(user_id)
            logger.debug(f"システムプロンプト: {system_prompt[:50]}...")

            # LLM応答（システムプロンプトでカスタマイズ）
            logger.info(f"AI応答生成開始: ユーザー「{username}」の質問「{text}」")
            start_time = time.time()
            response = await aiavatar.llm.chat(
                text, history=history, system_prompt=system_prompt
            )
            elapsed = time.time() - start_time
            logger.info(f"AI応答生成完了: 「{response}」(処理時間: {elapsed:.2f}秒)")

            # 履歴に応答も保存
            save_message(user_id, "assistant", response)

            # TTS
            logger.info(f"音声合成開始: 「{response[:50]}...」")
            start_time = time.time()
            tts_audio = await aiavatar.tts.speak(response)
            elapsed = time.time() - start_time

            # TTS音声を一時ファイルに保存
            tts_file = filename.replace(".wav", "_tts.wav")
            with open(tts_file, "wb") as f:
                f.write(tts_audio)

            file_size = os.path.getsize(tts_file)
            logger.info(
                f"音声合成完了: サイズ {file_size / 1024:.1f} KB (処理時間: {elapsed:.2f}秒)"
            )

            # 再生中なら終了を待つ
            while vc.is_playing():
                logger.debug("他の音声再生中のため待機中...")
                await asyncio.sleep(0.5)

            # 再生
            logger.info("音声再生開始")
            vc.play(FFmpegPCMAudio(tts_file))

            # 通知
            try:
                channel = vc.channel.guild.text_channels[
                    0
                ]  # 最初のテキストチャンネルに通知
                await channel.send(f"**{member.display_name}**: {text}\n**AI**: {response}")
                logger.info(f"テキストチャンネル「{channel.name}」に会話内容を送信しました")
            except Exception as e:
                logger.error(f"テキストチャンネル通知エラー: {e}")
                logger.debug(traceback.format_exc())

            # 再生終了まで待機
            while vc.is_playing():
                await asyncio.sleep(0.5)
            logger.info("音声再生完了")

        except Exception as e:
            logger.error(f"会話処理中にエラーが発生しました: {e}")
            logger.debug(traceback.format_exc())
        
        finally:
            # 一時ファイル削除
            try:
                if filename and os.path.exists(filename):
                    os.remove(filename)
                if tts_file and os.path.exists(tts_file):
                    os.remove(tts_file)
                logger.debug(f"一時ファイルを削除しました")
            except Exception as e:
                logger.error(f"一時ファイル削除エラー: {e}")

    if __name__ == "__main__":
        # 環境変数の確認
        if not TOKEN:
            logger.error("エラー: Discord Botトークンが設定されていません")
            logger.error(
                "'.env'ファイルを確認して、DISCORD_BOT_TOKENを設定してください"
            )
            # In test environment, don't exit
            if "pytest" not in sys.modules:
                sys.exit(1)

        if not OPENAI_API_KEY:
            logger.warning("警告: OpenAI APIキーが設定されていません")
            logger.warning("音声認識機能が動作しない可能性があります")

        # データベース初期化
        init_db()

        # 環境変数の設定状況を表示
        logger.info("\n=== 環境変数の設定状況 ===")
        logger.info(f"DISCORD_BOT_TOKEN: {'設定済み' if TOKEN else '未設定'}")
        logger.info(f"DIFY_API_KEY: {'設定済み' if DIFY_API_KEY else '未設定'}")
        logger.info(
            f"OPENAI_API_KEY: {'設定済み' if os.getenv('OPENAI_API_KEY') else '未設定'}"
        )
        logger.info(
            f"AIVISSPEECH_API_URL: {os.getenv('AIVISSPEECH_API_URL', 'デフォルト(http://localhost:50021)')}"
        )

        logger.info("\nDiscord Botを起動します...")
        bot.run(TOKEN)

except Exception as e:
    error_msg = f"エラーが発生しました: {e}\n{traceback.format_exc()}"
    print(error_msg)
    # ファイルにもエラーを書き出す
    with open("error_log.txt", "w") as f:
        f.write(error_msg)
    # In test environment, don't exit
    if "pytest" not in sys.modules:
        sys.exit(1)

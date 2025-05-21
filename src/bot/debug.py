import os
import sys
import pathlib
import dotenv

# 明示的に.envファイルを読み込む
dotenv.load_dotenv()

print("=== デバッグ情報 ===")
print(f"Python バージョン: {sys.version}")
print(f"現在のディレクトリ: {os.getcwd()}")
print(f"ファイルパス: {__file__}")

# 環境変数の確認
print("\n=== 環境変数 ===")
DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
DIFY_API_KEY = os.getenv("DIFY_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
AIVISSPEECH_API_URL = os.getenv("AIVISSPEECH_API_URL")

print(f"DISCORD_BOT_TOKEN: {'設定済み' if DISCORD_BOT_TOKEN else '未設定'}")
print(f"DIFY_API_KEY: {'設定済み' if DIFY_API_KEY else '未設定'}")
print(f"OPENAI_API_KEY: {'設定済み' if OPENAI_API_KEY else '未設定'}")
print(f"AIVISSPEECH_API_URL: {AIVISSPEECH_API_URL or 'デフォルト(未設定)'}")

# データベースファイルの確認
DB_PATH = str(pathlib.Path.cwd() / "aiavatar_bot.db")
print(f"\nデータベースパス: {DB_PATH}")
print(f"データベースファイルの存在: {os.path.exists(DB_PATH)}")
if os.path.exists(DB_PATH):
    print(f"データベースファイルサイズ: {os.path.getsize(DB_PATH)} バイト")

# 依存パッケージの確認
try:
    import discord

    print("\n=== 依存パッケージ ===")
    print(f"discord.py バージョン: {discord.__version__}")
except ImportError:
    print("discord.py がインストールされていません")

try:
    import aiavatar

    print(f"aiavatar バージョン: {aiavatar.__version__}")
except ImportError:
    print("aiavatar がインストールされていません")
except AttributeError:
    print("aiavatar はインストールされていますが、バージョン情報が取得できません")

print("\nデバッグ完了")

"""
データベース操作を行うモジュール
"""

import os
import sqlite3
import sys
from datetime import datetime

import config

# 親ディレクトリをインポートパスに追加
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def init_db():
    """
    データベースの初期化
    テーブルが存在しない場合は作成する
    """
    conn = sqlite3.connect(config.DB_PATH)
    c = conn.cursor()
    # 会話履歴テーブル
    c.execute("""
    CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp DATETIME NOT NULL
    )
    """)
    # システムプロンプトテーブル
    c.execute("""
    CREATE TABLE IF NOT EXISTS system_prompts (
        user_id INTEGER PRIMARY KEY,
        prompt TEXT NOT NULL,
        created_at DATETIME NOT NULL
    )
    """)
    # デフォルトシステムプロンプトテーブル
    c.execute("""
    CREATE TABLE IF NOT EXISTS default_system_prompt (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        prompt TEXT NOT NULL,
        updated_at DATETIME NOT NULL
    )
    """)
    # 録音設定テーブル
    c.execute("""
    CREATE TABLE IF NOT EXISTS recording_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        enabled BOOLEAN NOT NULL DEFAULT 1,
        keyword TEXT
    )
    """)
    conn.commit()
    conn.close()


def save_message(user_id, role, content):
    """
    会話履歴をデータベースに保存

    Args:
        user_id: ユーザーID
        role: メッセージの役割 (user/assistant)
        content: メッセージ内容
    """
    conn = sqlite3.connect(config.DB_PATH)
    c = conn.cursor()
    c.execute(
        "INSERT INTO conversation_history (user_id, role, content, timestamp) "
        "VALUES (?, ?, ?, ?)",
        (user_id, role, content, datetime.now()),
    )
    conn.commit()
    conn.close()


def get_user_history(user_id, limit=10):
    """
    ユーザーの会話履歴を取得

    Args:
        user_id: ユーザーID
        limit: 取得する履歴の件数

    Returns:
        会話履歴のリスト (時系列順)
    """
    conn = sqlite3.connect(config.DB_PATH)
    c = conn.cursor()
    c.execute(
        "SELECT role, content FROM conversation_history WHERE user_id = ? "
        "ORDER BY timestamp DESC LIMIT ?",
        (user_id, limit),
    )
    rows = c.fetchall()
    conn.close()
    # 古い順に変換
    history = [{"role": role, "content": content} for role, content in reversed(rows)]
    return history


def clear_user_history(user_id):
    """
    ユーザーの会話履歴をクリア

    Args:
        user_id: ユーザーID
    """
    conn = sqlite3.connect(config.DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM conversation_history WHERE user_id = ?", (user_id, ))
    conn.commit()
    conn.close()


def set_user_prompt(user_id, prompt):
    """
    ユーザーのシステムプロンプトを設定

    Args:
        user_id: ユーザーID
        prompt: システムプロンプト
    """
    conn = sqlite3.connect(config.DB_PATH)
    c = conn.cursor()
    c.execute(
        "INSERT OR REPLACE INTO system_prompts (user_id, prompt, created_at) "
        "VALUES (?, ?, ?)",
        (user_id, prompt, datetime.now()),
    )
    conn.commit()
    conn.close()


def set_default_system_prompt(prompt):
    """
    デフォルトのシステムプロンプトを設定

    Args:
        prompt: デフォルトのシステムプロンプト

    Returns:
        成功した場合はTrue、失敗した場合はFalse
    """
    try:
        conn = sqlite3.connect(config.DB_PATH)
        c = conn.cursor()
        c.execute(
            "INSERT OR REPLACE INTO default_system_prompt (id, prompt, updated_at) "
            "VALUES (?, ?, ?)",
            (1, prompt, datetime.now()),
        )
        conn.commit()
        conn.close()
        return True
    except sqlite3.Error:
        return False


def get_default_system_prompt():
    """
    デフォルトのシステムプロンプトを取得

    Returns:
        デフォルトのシステムプロンプト（なければハードコードされた値）
    """
    DEFAULT_SYSTEM_PROMPT = ("あなたは親切なAIアシスタントです。質問に簡潔に答えてください。")
    try:
        conn = sqlite3.connect(config.DB_PATH)
        c = conn.cursor()
        c.execute("SELECT prompt FROM default_system_prompt WHERE id = 1")
        row = c.fetchone()
        conn.close()
        return row[0] if row else DEFAULT_SYSTEM_PROMPT
    except sqlite3.Error:
        return DEFAULT_SYSTEM_PROMPT


def get_user_prompt(user_id):
    """
    ユーザーのシステムプロンプトを取得

    Args:
        user_id: ユーザーID

    Returns:
        システムプロンプト（なければデフォルト値）
    """
    conn = sqlite3.connect(config.DB_PATH)
    c = conn.cursor()
    c.execute("SELECT prompt FROM system_prompts WHERE user_id = ?", (user_id, ))
    row = c.fetchone()
    conn.close()

    if row:
        return row[0]  # ユーザー固有のプロンプトがある場合はそれを使用

    # ユーザー固有のプロンプトがない場合はデフォルトプロンプトを取得
    return get_default_system_prompt()


def set_recording_enabled(user_id, enabled=True, keyword=None):
    """
    ユーザーの録音設定を変更

    Args:
        user_id: ユーザーID
        enabled: 録音を有効にするか
        keyword: キーワードトリガー（指定された場合）
    """
    conn = sqlite3.connect(config.DB_PATH)
    c = conn.cursor()
    c.execute(
        "INSERT OR REPLACE INTO recording_settings (user_id, enabled, keyword) "
        "VALUES (?, ?, ?)",
        (user_id, enabled, keyword),
    )
    conn.commit()
    conn.close()


def reset_user_settings(user_id):
    """
    ユーザーの全設定をリセット

    Args:
        user_id: ユーザーID

    Returns:
        成功したかどうか
    """
    try:
        conn = sqlite3.connect(config.DB_PATH)
        c = conn.cursor()

        # システムプロンプトを削除
        c.execute("DELETE FROM system_prompts WHERE user_id = ?", (user_id, ))

        # 録音設定をリセット
        c.execute("DELETE FROM recording_settings WHERE user_id = ?", (user_id, ))

        conn.commit()
        conn.close()
        return True
    except Exception:
        return False


def get_database_stats():
    """
    データベースの統計情報を取得

    Returns:
        データベースの統計情報を含む辞書
    """
    conn = sqlite3.connect(config.DB_PATH)
    c = conn.cursor()

    # 会話履歴の件数
    c.execute("SELECT COUNT(*) FROM conversation_history")
    history_count = c.fetchone()[0]

    # ユニークユーザー数
    c.execute("SELECT COUNT(DISTINCT user_id) FROM conversation_history")
    unique_users = c.fetchone()[0]

    # システムプロンプト数
    c.execute("SELECT COUNT(*) FROM system_prompts")
    prompt_count = c.fetchone()[0]

    # 録音設定数
    c.execute("SELECT COUNT(*) FROM recording_settings")
    recording_settings_count = c.fetchone()[0]

    # 最も古いメッセージの日付
    c.execute("SELECT MIN(timestamp) FROM conversation_history")
    oldest_message = c.fetchone()[0]

    # 最も新しいメッセージの日付
    c.execute("SELECT MAX(timestamp) FROM conversation_history")
    newest_message = c.fetchone()[0]

    conn.close()

    return {
        "history_count": history_count,
        "unique_users": unique_users,
        "prompt_count": prompt_count,
        "recording_settings_count": recording_settings_count,
        "oldest_message": oldest_message,
        "newest_message": newest_message,
    }


def prune_old_conversations(days):
    """
    指定された日数より古い会話履歴を削除

    Args:
        days: 何日前より古い履歴を削除するか

    Returns:
        削除された行数
    """
    try:
        conn = sqlite3.connect(config.DB_PATH)
        c = conn.cursor()

        # 指定日数より古いレコードを削除
        # SQLiteでは日付計算にjulianday()を使用
        c.execute(
            """
            DELETE FROM conversation_history
            WHERE julianday('now') - julianday(timestamp) > ?
            """,
            (days, ),
        )

        deleted_count = c.rowcount
        conn.commit()
        conn.close()
        return deleted_count
    except Exception:
        return -1


def get_recording_settings(user_id):
    """
    ユーザーの録音設定を取得

    Args:
        user_id: ユーザーID

    Returns:
        (enabled, keyword) のタプル
        enabled: 録音が有効か
        keyword: キーワードトリガー（なければNone）
    """
    conn = sqlite3.connect(config.DB_PATH)
    c = conn.cursor()
    c.execute("SELECT enabled, keyword FROM recording_settings WHERE user_id = ?",
              (user_id, ))
    row = c.fetchone()
    conn.close()
    if not row:
        # デフォルト設定：録音有効、キーワードなし
        return True, None
    return row[0], row[1]


def get_all_users():
    """
    設定が保存されている全ユーザーのリストを取得

    Returns:
        ユーザーIDのリスト
    """
    conn = sqlite3.connect(config.DB_PATH)
    c = conn.cursor()

    # システムプロンプトテーブルからユーザーを取得
    c.execute("SELECT DISTINCT user_id FROM system_prompts")
    system_prompt_users = set(row[0] for row in c.fetchall())

    # 録音設定テーブルからユーザーを取得
    c.execute("SELECT DISTINCT user_id FROM recording_settings")
    recording_users = set(row[0] for row in c.fetchall())

    # 会話履歴テーブルからユーザーを取得
    c.execute("SELECT DISTINCT user_id FROM conversation_history")
    history_users = set(row[0] for row in c.fetchall())

    # すべてのユーザーを結合
    all_users = list(system_prompt_users | recording_users | history_users)

    conn.close()
    return all_users


def get_user_settings(user_id):
    """
    ユーザーの全設定を取得

    Args:
        user_id: ユーザーID

    Returns:
        ユーザー設定を含む辞書
    """
    conn = sqlite3.connect(config.DB_PATH)
    c = conn.cursor()

    # システムプロンプト
    c.execute("SELECT prompt FROM system_prompts WHERE user_id = ?", (user_id, ))
    prompt_row = c.fetchone()
    prompt = prompt_row[0] if prompt_row else None

    # 録音設定
    c.execute("SELECT enabled, keyword FROM recording_settings WHERE user_id = ?",
              (user_id, ))
    recording_row = c.fetchone()
    recording_enabled = recording_row[0] if recording_row else True
    keyword = recording_row[1] if recording_row else None

    # 会話履歴の件数
    c.execute("SELECT COUNT(*) FROM conversation_history WHERE user_id = ?",
              (user_id, ))
    message_count = c.fetchone()[0]

    conn.close()

    return {
        "prompt": prompt,
        "recording_enabled": recording_enabled,
        "keyword": keyword,
        "message_count": message_count,
    }

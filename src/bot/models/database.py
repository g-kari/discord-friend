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
    c.execute(
        """
    CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp DATETIME NOT NULL
    )
    """
    )
    # システムプロンプトテーブル
    c.execute(
        """
    CREATE TABLE IF NOT EXISTS system_prompts (
        user_id INTEGER PRIMARY KEY,
        prompt TEXT NOT NULL,
        created_at DATETIME NOT NULL
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
        "INSERT INTO conversation_history (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
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
        "SELECT role, content FROM conversation_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?",
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
    c.execute("DELETE FROM conversation_history WHERE user_id = ?", (user_id,))
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
        "INSERT OR REPLACE INTO system_prompts (user_id, prompt, created_at) VALUES (?, ?, ?)",
        (user_id, prompt, datetime.now()),
    )
    conn.commit()
    conn.close()


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
    c.execute("SELECT prompt FROM system_prompts WHERE user_id = ?", (user_id,))
    row = c.fetchone()
    conn.close()
    return (
        row[0]
        if row
        else config.DEFAULT_SYSTEM_PROMPT
    )


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
        "INSERT OR REPLACE INTO recording_settings (user_id, enabled, keyword) VALUES (?, ?, ?)",
        (user_id, enabled, keyword),
    )
    conn.commit()
    conn.close()


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
    c.execute(
        "SELECT enabled, keyword FROM recording_settings WHERE user_id = ?", (user_id,)
    )
    row = c.fetchone()
    conn.close()
    if not row:
        # デフォルト設定：録音有効、キーワードなし
        return True, None
    return row[0], row[1]

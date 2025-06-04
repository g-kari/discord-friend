"""
テスト用に aiavatar と関連モジュールをモック
"""
import sys
import os
from unittest.mock import MagicMock

# aiavatar モジュールとそのコンポーネントのモックを作成
mock_aiavatar = MagicMock()
mock_aiavatar.AIAvatar = MagicMock()
mock_aiavatar.AIAvatar.return_value = MagicMock()

# モックを sys.modules に追加
sys.modules['aiavatar'] = mock_aiavatar
sys.modules['pyaudio'] = MagicMock()

# pytest を実行
if __name__ == '__main__':
    import pytest
    sys.exit(pytest.main(["-v", "src/bot/tests/test_discord_aiavatar_complete.py"]))
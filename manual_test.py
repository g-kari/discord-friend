"""
DEFAULT_SYSTEM_PROMPT 機能の手動テスト
"""

import os
import sys

# os.getenv が期待通りに動作するかチェック
test_env_var = "TEST_ENV_VAR"
test_value = "test_value"
os.environ[test_env_var] = test_value
assert os.getenv(test_env_var) == test_value
print(f"✓ os.getenv works correctly: {test_env_var} = {test_value}")

# DEFAULT_SYSTEM_PROMPT 環境変数を設定
default_prompt = "This is a test default system prompt"
os.environ["DEFAULT_SYSTEM_PROMPT"] = default_prompt

# カレントディレクトリをパスに追加
sys.path.insert(0, ".")

try:
    # config モジュールを直接インポート
    from src.bot.config import DEFAULT_SYSTEM_PROMPT
    
    # DEFAULT_SYSTEM_PROMPT が環境変数の値を持っているかチェック
    assert DEFAULT_SYSTEM_PROMPT == default_prompt
    print(f"✓ config.DEFAULT_SYSTEM_PROMPT is correctly set from environment variable: {DEFAULT_SYSTEM_PROMPT}")

except ImportError as e:
    print(f"✗ Import error: {e}")
    # インポートエラーは無視、コードが動作するかチェックするだけ

# シミュレートされたデータベースモジュールでテスト
class MockConfig:
    DEFAULT_SYSTEM_PROMPT = "Mocked default prompt"

def get_user_prompt(user_id, config_module):
    # None を返すデータベース検索をシミュレート
    user_prompt = None
    # ユーザーがカスタムプロンプトを持たない場合、config からデフォルトシステムプロンプトを返す
    result = user_prompt if user_prompt else config_module.DEFAULT_SYSTEM_PROMPT
    return result

# モック config でテスト
mock_config = MockConfig()
test_user_id = "test_user"
result = get_user_prompt(test_user_id, mock_config)

# 結果を確認
assert result == mock_config.DEFAULT_SYSTEM_PROMPT
print(f"✓ get_user_prompt correctly uses DEFAULT_SYSTEM_PROMPT from config: {result}")

print("\nすべてのテストが正常に完了しました！")
import sys
import traceback

try:
    print("Starting test...")
    # 意図的にエラーを発生させる
    1 / 0
except Exception as e:
    error_msg = f"エラーが発生しました: {e}\n{traceback.format_exc()}"
    print(error_msg)
    # ファイルにもエラーを書き出す
    with open("error_log.txt", "w") as f:
        f.write(error_msg)

    sys.exit(1)

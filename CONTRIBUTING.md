# Discord AI Avatar Bot への貢献

このプロジェクトへの貢献に興味をお持ちいただき、ありがとうございます！このドキュメントでは、貢献のためのガイドラインと手順を提供します。

## 開発環境のセットアップ

### オプション 1: Dev Containers を使用する方法（推奨）

このプロジェクトは Dev Containers を使用するように設定されており、一貫した開発環境を提供します：

1. [Visual Studio Code](https://code.visualstudio.com/) をインストール
2. [Remote - Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) 拡張機能をインストール
3. リポジトリをクローンし、VS Code で開く
4. プロンプトが表示されたら「Reopen in Container」を選択するか、コマンドパレット（F1）から「Remote-Containers: Reopen in Container」を選択

### オプション 2: UV を使用したローカル開発

ローカルで開発したい場合：

1. Python 3.9 以上をインストール
2. `uv` をインストール：
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```
3. 仮想環境を作成してアクティベート：
   ```bash
   cd src/bot
   uv venv
   source .venv/bin/activate  # Windows の場合: .venv\Scripts\activate
   ```
4. 依存関係をインストール：
   ```bash
   uv pip install -r requirements.txt
   ```
5. 環境変数を設定：
   ```bash
   cp aiavatar_env.example .env
   # .env ファイルを設定で編集
   ```

## 開発ワークフロー

1. `main` から機能ブランチを作成
2. 変更を加える
3. リンティングとテストを実行：
   ```bash
   # 自動リンティングと修正、コミット
   ./scripts/lint_and_fix.sh --dir=src/
   
   # または個別にリンターを実行
   black src/
   isort src/
   flake8 src/
   mypy src/
   
   # テスト
   pytest src/bot/test_*.py
   ```
4. プルリクエストを提出

## コードスタイル

このプロジェクトは以下のコーディング標準に従っています：

- [Black](https://black.readthedocs.io/) - コードフォーマット（行の長さ：88）
- [isort](https://pycqa.github.io/isort/) - インポートのソート（プロファイル：black）
- [flake8](https://flake8.pycqa.org/) - リンティング
- [mypy](https://mypy.readthedocs.io/) - 型チェック

## プロジェクト構造

- `src/bot/` - メインボットコード
  - `discord_aiavatar_complete.py` - メインボットエントリーポイント
  - `config.py` - 設定と環境変数
  - `models/` - データモデルとデータベースの相互作用
  - `services/` - 外部サービス統合

## テスト

新機能やバグ修正のテストを記述してください。テストは以下で実行できます：

```bash
pytest src/bot/test_*.py
```

## ドキュメント

- 新しい関数、クラス、モジュールにはdocstringを記述
- 新機能やセットアップ手順の変更がある場合は README.md を更新
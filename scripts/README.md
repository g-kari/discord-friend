# Scripts

このディレクトリには、リポジトリの管理と開発に役立つ便利なスクリプトが含まれています。

> **📚 関連ドキュメント**: 
> - **[../README.md](../README.md)** - プロジェクト概要・基本的な使用方法
> - **[../CLAUDE.md](../CLAUDE.md)** - 開発者向け技術ガイド
> - **[../OLLAMA_TIPS.md](../OLLAMA_TIPS.md)** - Ollama最適化ガイド

---

## Git Secrets Scanner

このスクリプトは、Gitリポジトリの履歴から機密情報（APIキー、トークン、パスワードなど）を検出するためのツールです。

## 使い方

```bash
python scripts/check_git_secrets.py [--path リポジトリのパス] [--since 日付]
```

### オプション

- `--path`: Gitリポジトリのパス（デフォルト: カレントディレクトリ）
- `--since`: 指定した日付以降のコミットのみをチェック（例: '2023-01-01'）

### 実行例

```bash
# カレントディレクトリのリポジトリをスキャン
python scripts/check_git_secrets.py

# 特定のリポジトリをスキャン
python scripts/check_git_secrets.py --path /path/to/your/repo

# 2023年1月1日以降のコミットのみをスキャン
python scripts/check_git_secrets.py --since 2023-01-01
```

## 検出される機密情報の種類

- Discord トークン
- OpenAI API キー
- 一般的な API キー
- 機密情報（secret、privateなど）
- AWS アクセスキー
- 認証情報を含むURL

## 機密情報が検出された場合の推奨事項

1. 検出されたすべての機密情報を直ちに無効化・更新する
2. BFG Repo-Cleaner や git-filter-repo などのツールを使用して、Git履歴から機密情報を削除する
3. 機密情報を含むファイルに対して適切な .gitignore エントリを追加する
4. 環境変数や安全なシークレット管理ソリューションを使用する
5. 将来的に機密情報をコミットしないように pre-commit フックの導入を検討する

## Gitリポジトリから機密情報を削除する方法

コミット履歴から機密情報が見つかった場合、以下のツールを使用して削除することができます：

### BFG Repo-Cleaner を使用する

1. [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/) をダウンロード
2. 以下のコマンドを実行して、指定した文字列を置き換える

```bash
java -jar bfg.jar --replace-text passwords.txt my-repo.git
```

### git-filter-repo を使用する

1. [git-filter-repo](https://github.com/newren/git-filter-repo) をインストール
2. 以下のコマンドを実行してファイル内のすべての機密情報を置き換える

```bash
git filter-repo --replace-text expressions.txt
```

**注意**: これらのコマンドはリポジトリの履歴を変更します。共有リポジトリでこれを行う場合は、すべての貢献者に通知し、適切な手順で行ってください。

## セキュリティのベストプラクティス

1. **環境変数を使用する**: 機密情報はソースコードではなく環境変数に保存する
2. **.env ファイルを .gitignore に追加する**: .env ファイルは常にGitの管理対象外にする
3. **機密情報のサンプル値を使用する**: 例として `.env.example` ファイルにはサンプル値のみを含める
4. **pre-commit フックの使用**: [detect-secrets](https://github.com/Yelp/detect-secrets) などのツールを pre-commit フックとして設定する

## 定期的なチェック

セキュリティのためにこのスクリプトを定期的に実行することをお勧めします。これにより、リポジトリに誤って機密情報がコミットされていないことを確認できます。

```bash
# 毎月最初の日に実行する例
0 0 1 * * cd /path/to/repo && python scripts/check_git_secrets.py > security_report.txt
```

# Lint and Fix Script

このディレクトリには、Pythonコードの自動リンティングと修正を行うスクリプトも含まれています。

## 使い方

```bash
./scripts/lint_and_fix.sh [options]
```

### オプション

- `--no-commit`: 変更を自動コミットしない
- `--no-black`: blackを実行しない
- `--no-isort`: isortを実行しない
- `--no-flake8`: flake8を実行しない
- `--no-mypy`: mypyを実行しない
- `--message=commit-msg`: コミットメッセージを指定（デフォルト: "🤖 Auto-fix linting issues"）
- `--dir=src_dir`: ソースディレクトリを指定（デフォルト: "src"）

### 例

```bash
# デフォルト設定で実行（全てのリンターを実行し、変更があれば自動コミット）
./scripts/lint_and_fix.sh

# コミットせずに実行
./scripts/lint_and_fix.sh --no-commit

# カスタムコミットメッセージを指定
./scripts/lint_and_fix.sh --message="style: Fix import ordering and formatting"

# 特定のディレクトリのみチェック
./scripts/lint_and_fix.sh --dir=src/bot
```

## 機能

1. black と isort を使用してコードの自動フォーマット
2. flake8 と mypy を使用した追加のリンティングチェック
3. 自動フォーマットで行われた変更の自動コミット
4. 手動での修正が必要な問題の報告
# 機密情報の取り扱いガイドライン

このドキュメントは、Discord Friends プロジェクトにおける機密情報（APIキー、トークン、パスワードなど）の適切な取り扱い方法を説明します。

## 機密情報とは

以下のような情報は機密情報とみなされ、ソースコードに直接含めてはいけません：

- Discord Bot トークン
- OpenAI API キー
- Dify API キー
- データベースのパスワード
- アクセストークン
- パスワード
- 秘密鍵

## 機密情報の管理方法

### 1. 環境変数の使用

機密情報は環境変数として管理してください。直接ソースコードに記述しないでください。

```python
# 良い例
import os
token = os.getenv("DISCORD_BOT_TOKEN")

# 悪い例
token = "YOUR_BOT_TOKEN_HERE"  # 実際のトークンをここに直接書かないでください
```

### 2. .env ファイルの使用

開発環境では `.env` ファイルを使用して環境変数を設定できます。このファイルは `.gitignore` に含まれており、リポジトリにコミットされません。

```bash
# .env ファイルの例
DISCORD_BOT_TOKEN=your_discord_bot_token
OPENAI_API_KEY=your_openai_api_key
DIFY_API_KEY=your_dify_api_key
```

### 3. サンプルの環境変数ファイル

実際のキーやトークンを含まない `.env.example` ファイルをリポジトリに含めてください。新しい開発者がプロジェクトを設定する際のテンプレートとして使用できます。

```bash
# .env.example の例
DISCORD_BOT_TOKEN=your_discord_bot_token_here
DIFY_API_KEY=your_dify_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
```

### 4. 機密情報のチェック

コードをコミットする前に、機密情報が含まれていないことを確認するためにスクリプトを実行してください：

```bash
python scripts/check_git_secrets.py
```

### 5. pre-commit フックの設定

コミット時に自動的に機密情報をチェックするように pre-commit フックを設定できます：

```bash
# pre-commit フックを .git/hooks ディレクトリにリンク
ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
```

## 機密情報が誤ってコミットされた場合の対応

もし機密情報が誤ってコミットされてしまった場合は：

1. 該当する機密情報を直ちに無効化・更新してください（APIキーの再発行など）
2. リポジトリの履歴から機密情報を削除する必要があります
3. 詳細な手順は `scripts/README.md` を参照してください

## ベストプラクティス

1. **コードレビュー**: コードレビューの際に機密情報が含まれていないか確認する
2. **最小権限の原則**: 開発環境では必要最小限の権限を持つAPIキーを使用する
3. **定期的なローテーション**: 本番環境のAPIキーやトークンは定期的に更新する
4. **チーム全体での意識向上**: チームメンバー全員がセキュリティの重要性を理解する

## 機密情報の保管場所

1. **開発環境**: 各開発者のローカル環境の `.env` ファイル
2. **本番環境**: 環境変数またはシークレット管理サービス
3. **共有が必要な場合**: パスワードマネージャーやセキュアなチャットツールを使用

## 参考リンク

- [OWASP - Secure Coding Practices](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/)
- [Git の履歴からセンシティブデータを削除する方法](https://docs.github.com/ja/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
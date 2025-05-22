---
layout: default
title: 貢献ガイド
nav_order: 4
description: "Discord AI Voice Bot - 貢献ガイド"
permalink: /contributing/
---

# 貢献ガイド
{: .fs-9 }

Discord AI Voice Botへの貢献方法
{: .fs-6 .fw-300 }

このプロジェクトへの貢献に興味をお持ちいただき、ありがとうございます！このドキュメントでは、貢献するためのガイドラインと手順を提供します。

## 開発環境のセットアップ

### オプション 1: Dev Containers を使用する方法（推奨）

このプロジェクトは Dev Containers を使用して一貫した開発環境を提供します：

1. [Visual Studio Code](https://code.visualstudio.com/) をインストール
2. [Remote - Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) 拡張機能をインストール
3. リポジトリをクローンして VS Code で開く
4. プロンプトが表示されたら「Reopen in Container」を選択するか、コマンドパレット (F1) を使用して「Remote-Containers: Reopen in Container」を選択

### オプション 2: uvを使用したローカル開発

ローカルで開発する場合：

1. Python 3.9以上をインストール
2. `uv`をインストール：
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```
3. 仮想環境を作成して有効化：
   ```bash
   cd src/bot
   uv venv
   source .venv/bin/activate  # Windowsでは: .venv\Scripts\activate
   ```
4. 依存関係をインストール：
   ```bash
   uv pip install -r requirements.txt
   ```
5. 環境変数を設定：
   ```bash
   cp aiavatar_env.example .env
   # .envファイルを編集して設定
   ```

## 開発ワークフロー

1. `main`から機能ブランチを作成
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
  - `discord_aiavatar_complete.py` - メインボットのエントリーポイント
  - `config.py` - 設定と環境変数
  - `models/` - データモデルとデータベース操作
  - `services/` - 外部サービス連携

## テスト

新機能やバグ修正にはテストを書いてください。テストは以下のコマンドで実行できます：

```bash
pytest src/bot/test_*.py
```

## ドキュメント

- 新しい関数、クラス、モジュールにはdocstringを記述
- 新機能やセットアップ手順の変更がある場合はREADME.mdを更新

## プルリクエストのガイドライン

プルリクエストを提出する際は、以下の点に注意してください：

1. コードがすべてのテストに合格していることを確認
2. 変更内容の簡潔な説明を提供
3. 関連するIssueがある場合は参照
4. レビュアーが変更を理解しやすいように、小さな単位でのコミットを心がける

## コミュニケーション

質問や提案がある場合は、以下の方法で連絡できます：

- GitHub Issuesで新しいIssueを作成
- プルリクエストでコメント

## 行動規範

すべての貢献者は礼儀正しく協力的な態度で参加することが求められます。他者に対する尊敬を示し、建設的なフィードバックを提供してください。
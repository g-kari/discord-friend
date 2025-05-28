# Discord AI Voice Bot ドキュメント

このディレクトリには、Discord AI Voice Bot プロジェクトの GitHub Pages ドキュメントサイトのソースファイルが含まれています。

## 構造

- `_config.yml`: Jekyll設定ファイル
- `index.md`: ホームページ
- `development.md`: 開発ガイド
- `contributing.md`: 貢献ガイド
- `security.md`: セキュリティガイドライン
- `features/`: 機能固有のドキュメントを含むディレクトリ
  - `features/index.md`: 機能概要
  - `features/mcp-servers.md`: MCPサーバー自動接続機能のドキュメント

## ローカル開発

ドキュメントサイトをローカルでテストするには：

1. JekyllとDependenciesをインストール：
   ```bash
   gem install bundler jekyll
   ```

2. 以下の内容でGemfileを作成：
   ```ruby
   source "https://rubygems.org"
   gem "github-pages", group: :jekyll_plugins
   gem "jekyll-remote-theme"
   ```

3. 依存関係をインストール：
   ```bash
   bundle install
   ```

4. ローカルサーバーを起動：
   ```bash
   bundle exec jekyll serve
   ```

5. ブラウザで http://localhost:4000 を開く

## 新しいドキュメントの追加

新しいドキュメントを追加するには：

1. 適切なフロントマターを含む新しいMarkdownファイルを作成：
   ```yaml
   ---
   layout: default
   title: ページタイトル
   nav_order: X  # ナビゲーションでの順序を制御
   description: "簡単な説明"
   permalink: /your-page-url/
   ---
   ```

2. 機能固有のドキュメントの場合は、`features/` ディレクトリに追加し、以下を含める：
   ```yaml
   ---
   parent: 機能ガイド  # これにより機能セクションの下にリンクされます
   ---
   ```

3. 必要に応じて他のページのリンクを更新
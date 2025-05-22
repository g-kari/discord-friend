# Discord AI Voice Bot Documentation

This directory contains the source files for the GitHub Pages documentation site of the Discord AI Voice Bot project.

## Structure

- `_config.yml`: Jekyll configuration file
- `index.md`: Home page
- `development.md`: Development guide
- `contributing.md`: Contributing guide
- `security.md`: Security guidelines
- `features/`: Directory containing feature-specific documentation
  - `features/index.md`: Features overview
  - `features/mcp-servers.md`: MCP servers auto-join feature documentation

## Local Development

To test the documentation site locally:

1. Install Jekyll and dependencies:
   ```bash
   gem install bundler jekyll
   ```

2. Create a Gemfile with:
   ```ruby
   source "https://rubygems.org"
   gem "github-pages", group: :jekyll_plugins
   gem "jekyll-remote-theme"
   ```

3. Install dependencies:
   ```bash
   bundle install
   ```

4. Run the local server:
   ```bash
   bundle exec jekyll serve
   ```

5. Open your browser at http://localhost:4000

## Adding New Documentation

To add new documentation:

1. Create a new Markdown file with the appropriate frontmatter:
   ```yaml
   ---
   layout: default
   title: Your Page Title
   nav_order: X  # Control the order in the navigation
   description: "Brief description"
   permalink: /your-page-url/
   ---
   ```

2. For feature-specific documentation, add to the `features/` directory and include:
   ```yaml
   ---
   parent: 機能ガイド  # This links it under the Features section
   ---
   ```

3. Update links in other pages as needed
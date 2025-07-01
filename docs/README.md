# GitHub Pages Documentation

This directory contains the documentation site for the Discord AI Voice Bot project, built with Jekyll and hosted on GitHub Pages.

## 🌐 Live Site

The documentation is available at: [https://g-kari.github.io/discord-friend/](https://g-kari.github.io/discord-friend/)

## 📁 Structure

```
docs/
├── index.md              # Main landing page
├── getting-started.md    # Installation and setup guide
├── development.md        # Development environment guide
├── api-reference.md      # API and command documentation
├── troubleshooting.md    # Problem diagnosis and solutions
├── 404.md               # Custom 404 page
├── _config.yml          # Jekyll configuration
├── Gemfile              # Ruby dependencies
└── README.md            # This file
```

## 🚀 Local Development

To run the documentation site locally:

```bash
# Install dependencies
bundle install

# Serve locally (http://localhost:4000)
bundle exec jekyll serve

# Build for production
bundle exec jekyll build
```

## 🔧 GitHub Pages Workflow

The site is automatically built and deployed via GitHub Actions when:
- Changes are pushed to the `main` branch in the `docs/` directory
- The GitHub Pages workflow is manually triggered

See: `.github/workflows/github-pages.yml`

## 📝 Contributing

To contribute to the documentation:

1. Edit the relevant Markdown files in this directory
2. Test locally using `bundle exec jekyll serve`
3. Submit a Pull Request with your changes

## 🏗️ Jekyll Configuration

- **Theme**: Minima (GitHub Pages compatible)
- **Plugins**: jekyll-feed, jekyll-sitemap, jekyll-seo-tag
- **Markdown**: Kramdown with syntax highlighting
- **Base URL**: `/discord-friend` (GitHub Pages subdirectory)
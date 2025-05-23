# Contributing to Discord AI Avatar Bot

Thank you for your interest in contributing to this project! This document provides guidelines and instructions for contributing.

## Development Environment Setup

### Option 1: Using Dev Containers (Recommended)

This project is set up to use Dev Containers, which provides a consistent development environment:

1. Install [Visual Studio Code](https://code.visualstudio.com/)
2. Install the [Remote - Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension
3. Clone the repository and open it in VS Code
4. When prompted, select "Reopen in Container" or use the command palette (F1) and select "Remote-Containers: Reopen in Container"

### Option 2: Local Development with UV

If you prefer to develop locally:

1. Install Python 3.9 or higher
2. Install `uv`:
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```
3. Create and activate a virtual environment:
   ```bash
   cd src/bot
   uv venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   ```
4. Install dependencies:
   ```bash
   uv pip install -r requirements.txt
   ```
5. Set up environment variables:
   ```bash
   cp aiavatar_env.example .env
   # Edit .env with your configuration
   ```

## Development Workflow

1. Create a feature branch from `main`
2. Make your changes
3. Run linting and tests:
   ```bash
   # Automatic linting with fixes and commit
   ./scripts/lint_and_fix.sh --dir=src/
   
   # Or run linters individually
   black src/
   isort src/
   flake8 src/
   mypy src/
   
   # Tests
   pytest src/bot/test_*.py
   ```
4. Submit a pull request

## Code Style

This project follows these coding standards:

- [Black](https://black.readthedocs.io/) for code formatting (line length: 88)
- [isort](https://pycqa.github.io/isort/) for import sorting (profile: black)
- [flake8](https://flake8.pycqa.org/) for linting
- [mypy](https://mypy.readthedocs.io/) for type checking

## Project Structure

- `src/bot/` - Main bot code
  - `discord_aiavatar_complete.py` - Main bot entry point
  - `config.py` - Configuration and environment variables
  - `models/` - Data models and database interactions
  - `services/` - External service integrations

## Testing

Write tests for new features or bug fixes. Run tests with:

```bash
pytest src/bot/test_*.py
```

## Documentation

- Document new functions, classes, and modules with docstrings
- Update README.md if needed with new features or changes in setup instructions
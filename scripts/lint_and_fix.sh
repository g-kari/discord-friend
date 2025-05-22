#!/bin/bash
#
# Lint and fix script for Python code
# This script runs linters, automatically fixes issues where possible,
# and optionally commits those changes
#

set -e  # Exit on error

# Default values
SRC_DIR="src"
COMMIT=true
RUN_BLACK=true
RUN_ISORT=true
RUN_FLAKE8=true
RUN_MYPY=true
COMMIT_MSG="🤖 Auto-fix linting issues"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-commit)
      COMMIT=false
      shift
      ;;
    --no-black)
      RUN_BLACK=false
      shift
      ;;
    --no-isort)
      RUN_ISORT=false
      shift
      ;;
    --no-flake8)
      RUN_FLAKE8=false
      shift
      ;;
    --no-mypy)
      RUN_MYPY=false
      shift
      ;;
    --message=*)
      COMMIT_MSG="${1#*=}"
      shift
      ;;
    --dir=*)
      SRC_DIR="${1#*=}"
      shift
      ;;
    *)
      echo -e "${RED}Error: Unknown option: $1${NC}"
      echo "Usage: $0 [--no-commit] [--no-black] [--no-isort] [--no-flake8] [--no-mypy] [--message=commit-msg] [--dir=src_dir]"
      exit 1
      ;;
  esac
done

# Check if we're in a git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo -e "${RED}Error: Not inside a git repository${NC}"
  exit 1
fi

# Check for unstaged changes
if [[ $(git status --porcelain) ]]; then
  echo -e "${YELLOW}Warning: You have unstaged changes.${NC}"
  echo -e "${YELLOW}This script will only commit changes made by the linting tools.${NC}"
  echo -e "${YELLOW}Other changes will remain unstaged.${NC}"
fi

# Check if required tools are installed
check_command() {
  if ! command -v $1 > /dev/null; then
    echo -e "${RED}Error: $1 is not installed. Please install it with: pip install $1${NC}"
    exit 1
  fi
}

if $RUN_BLACK; then check_command black; fi
if $RUN_ISORT; then check_command isort; fi
if $RUN_FLAKE8; then check_command flake8; fi
if $RUN_MYPY; then check_command mypy; fi

# Track whether any changes were made
CHANGES_MADE=false
LINTING_ERRORS=false

# Run formatters that can fix issues automatically
if $RUN_BLACK; then
  echo -e "${BLUE}Running black...${NC}"
  # Use --check first to see if there are any changes needed
  if ! black --check $SRC_DIR 2>/dev/null; then
    # Then run black to make the changes
    black $SRC_DIR
    echo -e "${GREEN}Black made some changes.${NC}"
    CHANGES_MADE=true
  else
    echo -e "${GREEN}Black: No changes needed.${NC}"
  fi
fi

if $RUN_ISORT; then
  echo -e "${BLUE}Running isort...${NC}"
  # Use --check first to see if there are any changes needed
  if ! isort --check $SRC_DIR 2>/dev/null; then
    # Then run isort to make the changes
    isort $SRC_DIR
    echo -e "${GREEN}isort made some changes.${NC}"
    CHANGES_MADE=true
  else
    echo -e "${GREEN}isort: No changes needed.${NC}"
  fi
fi

# Run linters that only report issues
if $RUN_FLAKE8; then
  echo -e "${BLUE}Running flake8...${NC}"
  if ! flake8 $SRC_DIR; then
    echo -e "${YELLOW}flake8 found issues that need to be fixed manually.${NC}"
    LINTING_ERRORS=true
  else
    echo -e "${GREEN}flake8: No issues found.${NC}"
  fi
fi

if $RUN_MYPY; then
  echo -e "${BLUE}Running mypy...${NC}"
  if ! mypy $SRC_DIR; then
    echo -e "${YELLOW}mypy found issues that need to be fixed manually.${NC}"
    LINTING_ERRORS=true
  else
    echo -e "${GREEN}mypy: No issues found.${NC}"
  fi
fi

# Commit changes if any were made
if $COMMIT && $CHANGES_MADE; then
  echo -e "${BLUE}Committing changes made by linters...${NC}"
  git add $SRC_DIR
  git commit -m "$COMMIT_MSG"
  echo -e "${GREEN}Changes have been committed with message: '$COMMIT_MSG'${NC}"
fi

# Final status message
if $CHANGES_MADE; then
  echo -e "${GREEN}Automatic fixes applied successfully.${NC}"
fi

if $LINTING_ERRORS; then
  echo -e "${YELLOW}Some linting issues require manual fixes. See the output above.${NC}"
  exit 1
else
  echo -e "${GREEN}All linting checks passed!${NC}"
  exit 0
fi
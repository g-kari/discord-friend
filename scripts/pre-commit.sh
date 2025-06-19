#!/bin/sh
#
# Pre-commit hook to detect potential secrets in the files being committed
# Install this by: ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
#

echo "Running pre-commit hook to check for secrets..."

# Run the check_git_secrets.py script on the files being committed
FILES=$(git diff --cached --name-only --diff-filter=ACM)
ERROR=0

if [ -z "$FILES" ]; then
    echo "No files to check. Skipping secret detection."
    exit 0
fi

# Create a temporary file with current staged content
TEMP_DIR=$(mktemp -d)
STAGED_FILES=()

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# Copy staged files to temp directory
for FILE in $FILES; do
    # Skip binary files
    if file "$FILE" | grep -q "text"; then
        DEST="$TEMP_DIR/$FILE"
        mkdir -p "$(dirname "$DEST")"
        git show ":$FILE" > "$DEST"
        STAGED_FILES+=("$DEST")
    fi
done

# Check for common patterns of secrets
check_file() {
    FILE="$1"
    BASENAME=$(basename "$FILE")
    
    # Skip if the file is in .git directory
    if echo "$FILE" | grep -q "^\.git/"; then
        return 0
    fi
    
    # Look for common secret patterns
    SECRET_PATTERNS=(
        # Discord Token
        'discord.*token.*=.*[a-zA-Z0-9_-]{24}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27}'
        'bot.*token.*=.*[a-zA-Z0-9_-]{24}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27}'
        
        # OpenAI API Key
        'openai.*key.*=.*sk-[a-zA-Z0-9]{48}'
        'sk-[a-zA-Z0-9]{48}'
        
        # Generic API Keys/Tokens/Passwords
        'api.*key.*=.*[a-zA-Z0-9_-]{20,64}'
        'password.*=.*[^a-zA-Z0-9](.{8,64})'
        'secret.*=.*[^a-zA-Z0-9](.{8,64})'
        
        # AWS
        'AKIA[0-9A-Z]{16}'
        
        # URLs with credentials
        'https?://[^@:]+:[^@:]+@'
    )
    
    # Exception patterns - ok to ignore
    EXCEPTION_PATTERNS=(
        'your_.*_here'
        'example'
        'placeholder'
        'dummy'
        'xxx'
        '<.*>'
        'test'
        'sample'
    )
    
    for PATTERN in "${SECRET_PATTERNS[@]}"; do
        MATCHES=$(grep -E "$PATTERN" "$FILE" || true)
        if [ -n "$MATCHES" ]; then
            # Check if it's an exception
            IS_EXCEPTION=0
            for EXCEPTION in "${EXCEPTION_PATTERNS[@]}"; do
                if echo "$MATCHES" | grep -E "$EXCEPTION" > /dev/null; then
                    IS_EXCEPTION=1
                    break
                fi
            done
            
            if [ $IS_EXCEPTION -eq 0 ]; then
                echo "ERROR: Potential secret found in $BASENAME:"
                echo "$MATCHES" | sed 's/^\(.\{10\}\).*\(.\{10\}\)$/\1**********\2/'
                ERROR=1
            fi
        fi
    done
}

echo "Checking files for secrets..."
for FILE in "${STAGED_FILES[@]}"; do
    check_file "$FILE"
done

if [ $ERROR -ne 0 ]; then
    echo "Error: Potential secrets found in your commit!"
    echo "Please remove the secrets and try committing again."
    echo "If you believe this is a false positive, you can bypass this check with git commit --no-verify"
    exit 1
fi

echo "No secrets found. Proceeding with commit."
exit 0
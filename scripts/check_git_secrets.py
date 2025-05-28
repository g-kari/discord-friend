#!/usr/bin/env python3
"""
Check Git history for potential secrets and sensitive information.

This script scans the Git history of a repository for patterns that may indicate
sensitive information such as API keys, tokens, and passwords.

Usage:
    python check_git_secrets.py [--path REPO_PATH] [--since COMMIT_DATE]

Options:
    --path REPO_PATH    Path to the Git repository (default: current directory)
    --since COMMIT_DATE Only check commits after this date (e.g. '2023-01-01')
    --help              Show this help message
"""

import argparse
import os
import re
import subprocess
import sys
from datetime import datetime


# Regex patterns for common secrets
SECRET_PATTERNS = {
    'Discord Token': r'(?:discord|bot)[^a-zA-Z0-9](?:token|key)[^a-zA-Z0-9]+([a-zA-Z0-9_-]{24}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27}|[a-zA-Z0-9_-]{59})',
    'OpenAI API Key': r'(?:openai|sk-)[^a-zA-Z0-9](?:token|key|secret)[^a-zA-Z0-9]+([sS][kK]-[a-zA-Z0-9]{48})',
    'Generic API Key': r'(?:api[^a-zA-Z0-9]|key[^a-zA-Z0-9]|token[^a-zA-Z0-9]|secret[^a-zA-Z0-9]|password[^a-zA-Z0-9]|pw[^a-zA-Z0-9]|pwd[^a-zA-Z0-9])[^a-zA-Z0-9]+([a-zA-Z0-9_\-\.]{20,64})',
    'Generic Secret': r'(?:secret|private)[^a-zA-Z0-9]+([a-zA-Z0-9_\-\.]{16,64})',
    'AWS Access Key': r'(AKIA[0-9A-Z]{16})',
    'URL with credentials': r'(https?://[^:\s]+:[^@\s]+@[^\s]+)',
}

# Ignore patterns for common false positives
IGNORE_PATTERNS = [
    r'example',
    r'placeholder',
    r'dummy',
    r'your_',
    r'xxx',
    r'<.*>',
    r'\.example',
    r'test',
    r'sample',
]


class GitSecretScanner:
    """Scanner for detecting secrets in Git repositories."""

    def __init__(self, repo_path='.', since=None):
        """Initialize the scanner.

        Args:
            repo_path: Path to the Git repository
            since: Only check commits after this date
        """
        self.repo_path = os.path.abspath(repo_path)
        self.since = since
        self.findings = []

        if not os.path.isdir(os.path.join(self.repo_path, '.git')):
            raise ValueError(f"Not a Git repository: {self.repo_path}")

    def _run_git_command(self, command):
        """Run a Git command and return the output.

        Args:
            command: Git command to run (list of arguments)

        Returns:
            Output of the Git command
        """
        try:
            result = subprocess.run(
                ['git'] + command,
                cwd=self.repo_path,
                check=True,
                capture_output=True,
                text=True
            )
            return result.stdout
        except subprocess.CalledProcessError as e:
            print(f"Error running Git command: {e}")
            print(f"Error output: {e.stderr}")
            return ""

    def _is_false_positive(self, line):
        """Check if a line is likely a false positive.

        Args:
            line: Line to check

        Returns:
            True if the line is likely a false positive, False otherwise
        """
        lower_line = line.lower()
        for pattern in IGNORE_PATTERNS:
            if re.search(pattern, lower_line, re.IGNORECASE):
                return True
        return False

    def scan_git_history(self):
        """Scan Git history for potential secrets.

        Returns:
            List of findings (dictionaries with commit info and detected secrets)
        """
        # Prepare the git log command
        git_log_cmd = ['log', '-p', '--all']
        if self.since:
            git_log_cmd.extend(['--since', self.since])

        # Run the git log command
        git_log_output = self._run_git_command(git_log_cmd)
        
        # Process the output
        current_commit = None
        lines = git_log_output.split('\n')
        
        for i, line in enumerate(lines):
            # Parse commit info
            if line.startswith('commit '):
                commit_hash = line.split(' ')[1]
                # Get author and date from the next lines
                author_line = lines[i+1] if i+1 < len(lines) else ""
                date_line = lines[i+2] if i+2 < len(lines) else ""
                
                author = author_line.replace('Author:', '').strip() if author_line.startswith('Author:') else ""
                date_str = date_line.replace('Date:', '').strip() if date_line.startswith('Date:') else ""
                
                current_commit = {
                    'hash': commit_hash,
                    'author': author,
                    'date': date_str,
                    'secrets': []
                }
                
            # Skip lines that are not part of a diff (not added or removed)
            elif line.startswith('+') and not line.startswith('+++'):
                # Skip false positives
                if self._is_false_positive(line):
                    continue
                
                # Check for secrets
                for secret_type, pattern in SECRET_PATTERNS.items():
                    matches = re.finditer(pattern, line, re.IGNORECASE)
                    for match in matches:
                        # Do another check for false positive on the match itself
                        matched_text = match.group(1) if match.groups() else match.group(0)
                        if not self._is_false_positive(matched_text):
                            if current_commit and current_commit not in self.findings:
                                self.findings.append(current_commit)
                            
                            current_commit['secrets'].append({
                                'type': secret_type,
                                'text': line.lstrip('+'),
                                'value': matched_text
                            })
        
        # Filter out commits without secrets
        self.findings = [commit for commit in self.findings if commit['secrets']]
        return self.findings

    def print_report(self):
        """Print a report of the findings."""
        if not self.findings:
            print("No secrets found in the Git history.")
            return

        print(f"\n{'=' * 80}")
        print(f"SECRETS FOUND IN GIT HISTORY")
        print(f"{'=' * 80}\n")
        
        for i, commit in enumerate(self.findings):
            print(f"Commit: {commit['hash']}")
            print(f"Author: {commit['author']}")
            print(f"Date:   {commit['date']}")
            print("\nSecrets found:")
            
            for secret in commit['secrets']:
                print(f"  - Type: {secret['type']}")
                # Mask the actual value in the output
                print(f"    Value: [REDACTED]")
            
            if i < len(self.findings) - 1:
                print(f"\n{'-' * 80}\n")

        print(f"\n{'=' * 80}")
        print(f"RECOMMENDATIONS")
        print(f"{'=' * 80}")
        print("1. Revoke and rotate all detected secrets immediately")
        print("2. Remove secrets from Git history using tools like BFG Repo-Cleaner or git-filter-repo")
        print("3. Add proper .gitignore entries for files containing secrets")
        print("4. Use environment variables or a secure secret management solution")
        print("5. Consider adding a pre-commit hook to prevent committing secrets in the future")


def main():
    """Main function."""
    parser = argparse.ArgumentParser(description='Check Git history for potential secrets.')
    parser.add_argument('--path', default='.', help='Path to the Git repository')
    parser.add_argument('--since', help='Only check commits after this date (e.g. "2023-01-01")')
    args = parser.parse_args()

    try:
        scanner = GitSecretScanner(repo_path=args.path, since=args.since)
        scanner.scan_git_history()
        scanner.print_report()
        
        # Exit with non-zero code if secrets were found
        sys.exit(1 if scanner.findings else 0)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
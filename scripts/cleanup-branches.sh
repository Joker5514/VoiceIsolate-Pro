#!/usr/bin/env bash
# VoiceIsolate Pro — Branch Cleanup Script
# Deletes all excess branches except main and active feature branches
set -euo pipefail

REPO="Joker5514/VoiceIsolate-Pro"
KEEP_PATTERN="^(main|feature/v21)"

echo "=== VoiceIsolate Pro — Branch Cleanup ==="
echo "Repository: $REPO"
echo "Keeping branches matching: $KEEP_PATTERN"
echo ""

# Get all remote branches
BRANCHES=$(git branch -r | sed 's|origin/||' | tr -d ' ' | grep -v "^HEAD")

DELETED=0
KEPT=0

for branch in $BRANCHES; do
  if echo "$branch" | grep -qE "$KEEP_PATTERN"; then
    echo "KEEP: $branch"
    KEPT=$((KEPT + 1))
  else
    echo "DELETE: $branch"
    gh api -X DELETE "repos/$REPO/git/refs/heads/$branch" 2>/dev/null && \
      echo "  ✓ Deleted" || echo "  ⚠ Failed (may already be deleted)"
    DELETED=$((DELETED + 1))
  fi
done

echo ""
echo "=== Summary ==="
echo "Kept: $KEPT branches"
echo "Deleted: $DELETED branches"

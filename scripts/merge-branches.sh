#!/bin/bash
#
# merge-branches.sh
# Merges all local Git branches into the main branch.
#
# Features:
# - Checks out and pulls the latest main branch
# - Loops through all local branches except main
# - Attempts to merge each branch into main
# - Handles merge conflicts by aborting and logging to failed_merges.txt
# - Prints a final summary of successful and failed merges
#

set -e

# Configuration
MAIN_BRANCH="main"
FAILED_LOG="failed_merges.txt"

# Arrays to track results
successful_merges=()
failed_merges=()

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored message
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Ensure we're in a git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    print_error "Not inside a Git repository. Please run this script from within a Git repository."
    exit 1
fi

# Get the repository root
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# Clear previous failed merges log
: > "$FAILED_LOG"

print_info "Starting branch merge process..."
echo ""

# Step 1: Checkout and pull the latest main branch
print_info "Checking out '$MAIN_BRANCH' branch..."
if ! git checkout "$MAIN_BRANCH" 2>/dev/null; then
    print_error "Failed to checkout '$MAIN_BRANCH' branch. Make sure it exists."
    exit 1
fi

print_info "Pulling latest changes from '$MAIN_BRANCH'..."
if ! git pull origin "$MAIN_BRANCH" 2>/dev/null; then
    print_warning "Failed to pull from remote. Continuing with local state..."
fi

echo ""

# Step 2: Get all local branches except main
branches=$(git branch --format='%(refname:short)' | grep -v "^${MAIN_BRANCH}$" || true)

if [ -z "$branches" ]; then
    print_info "No other branches found to merge."
    exit 0
fi

print_info "Found the following branches to merge:"
echo "$branches" | while read -r branch; do
    echo "  - $branch"
done
echo ""

# Step 3: Loop through and merge each branch
while IFS= read -r branch; do
    # Skip empty lines
    [ -z "$branch" ] && continue
    
    print_info "Attempting to merge '$branch' into '$MAIN_BRANCH'..."
    
    # Attempt the merge
    if git merge "$branch" --no-edit 2>/dev/null; then
        print_success "Successfully merged '$branch'"
        successful_merges+=("$branch")
    else
        # Merge conflict occurred - abort and log
        print_error "Merge conflict detected for '$branch'. Aborting merge..."
        git merge --abort 2>/dev/null || true
        
        # Log to failed_merges.txt
        echo "$branch" >> "$FAILED_LOG"
        failed_merges+=("$branch")
    fi
    
    echo ""
done <<< "$branches"

# Step 4: Print final summary
echo "=============================================="
echo "           MERGE SUMMARY"
echo "=============================================="
echo ""

# Successful merges
echo -e "${GREEN}Successful Merges (${#successful_merges[@]}):${NC}"
if [ ${#successful_merges[@]} -eq 0 ]; then
    echo "  None"
else
    for branch in "${successful_merges[@]}"; do
        echo "  ✓ $branch"
    done
fi
echo ""

# Failed merges
echo -e "${RED}Failed Merges (${#failed_merges[@]}):${NC}"
if [ ${#failed_merges[@]} -eq 0 ]; then
    echo "  None"
else
    for branch in "${failed_merges[@]}"; do
        echo "  ✗ $branch"
    done
    echo ""
    print_info "Failed branches have been logged to: $FAILED_LOG"
fi

echo ""
echo "=============================================="

# Exit with appropriate code
if [ ${#failed_merges[@]} -gt 0 ]; then
    exit 1
fi

exit 0

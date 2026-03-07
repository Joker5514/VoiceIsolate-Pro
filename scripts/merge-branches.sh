#!/usr/bin/env bash
#
# merge-branches.sh
# Merges all local Git branches into a main branch.
#
# Features:
# - Checks for clean working tree and no in-progress merge/rebase
# - Checks out and updates main safely (fetch + ff-only)
# - Loops through all local branches except main
# - Attempts to merge each branch into main (or dry-run)
# - Handles merge failures by aborting and logging to failed_merges.txt
# - Prints a final summary of successful and failed merges
#

# Intentionally not using `set -e` because we want to continue after a failed merge.
set -u

# Defaults / configuration
MAIN_BRANCH="main"
REMOTE="origin"
DO_PULL=1
DRY_RUN=0
ASSUME_YES=0
FAILED_LOG_BASENAME="failed_merges.txt"

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
    echo -e "${BLUE}[INFO]${NC} $*"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $*"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Merge all local Git branches into a main branch.

Options:
  -m, --main <branch>   Target branch to merge into (default: main)
  -r, --remote <name>   Remote name for fetching (default: origin)
  -n, --dry-run         Test merges without committing
  -y, --yes             Skip confirmation prompt
  --no-pull             Skip fetching/updating main from remote
  -h, --help            Show this help message

Examples:
  $(basename "$0")                    # Interactive mode, merge into main
  $(basename "$0") --yes              # Skip confirmation
  $(basename "$0") --dry-run          # Test merges without changes
  $(basename "$0") --main develop     # Merge into develop instead
  $(basename "$0") --no-pull --yes    # Local-only, no prompts

EOF
    exit 0
}

# Parse command-line arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -m|--main)
            MAIN_BRANCH="$2"
            shift 2
            ;;
        -r|--remote)
            REMOTE="$2"
            shift 2
            ;;
        -n|--dry-run)
            DRY_RUN=1
            shift
            ;;
        -y|--yes)
            ASSUME_YES=1
            shift
            ;;
        --no-pull)
            DO_PULL=0
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            print_error "Unknown option: $1"
            usage
            ;;
    esac
done

# Ensure we're in a git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    print_error "Not inside a Git repository. Please run this script from within a Git repository."
    exit 1
fi

# Get the repository root
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT" || exit 1

FAILED_LOG="${REPO_ROOT}/${FAILED_LOG_BASENAME}"

# Safety checks: in-progress merge/rebase
GIT_DIR="$(git rev-parse --git-dir)"
if [[ -f "${GIT_DIR}/MERGE_HEAD" ]] || [[ -d "${GIT_DIR}/rebase-apply" ]] || [[ -d "${GIT_DIR}/rebase-merge" ]]; then
    print_error "A merge/rebase appears to be in progress. Resolve it before running this script."
    exit 1
fi

# Safety checks: clean working tree (unstaged + staged)
if ! git diff --quiet || ! git diff --cached --quiet; then
    print_error "Working tree is not clean. Commit/stash changes before running."
    git status --porcelain
    exit 1
fi

# Clear previous failed merges log (overwrite each run)
: > "$FAILED_LOG"

print_info "Starting branch merge process..."
print_info "Repository root: $REPO_ROOT"
print_info "Main branch: $MAIN_BRANCH"
print_info "Remote: $REMOTE"
print_info "Update main: $([[ $DO_PULL -eq 1 ]] && echo yes || echo no)"
print_info "Dry-run: $([[ $DRY_RUN -eq 1 ]] && echo yes || echo no)"
echo ""

# Ensure main exists locally or can be created from remote
if ! git show-ref --verify --quiet "refs/heads/${MAIN_BRANCH}"; then
    print_warning "Local branch '$MAIN_BRANCH' not found."
    if git show-ref --verify --quiet "refs/remotes/${REMOTE}/${MAIN_BRANCH}"; then
        print_info "Creating local '$MAIN_BRANCH' from '${REMOTE}/${MAIN_BRANCH}'..."
        git checkout -b "$MAIN_BRANCH" "${REMOTE}/${MAIN_BRANCH}"
    else
        print_error "Neither local '$MAIN_BRANCH' nor '${REMOTE}/${MAIN_BRANCH}' exists."
        exit 1
    fi
fi

print_info "Checking out '$MAIN_BRANCH' branch..."
git checkout "$MAIN_BRANCH"

if [[ $DO_PULL -eq 1 ]]; then
    if git remote get-url "$REMOTE" >/dev/null 2>&1; then
        print_info "Fetching latest changes from '$REMOTE'..."
        if git fetch "$REMOTE"; then
            print_info "Fast-forwarding '$MAIN_BRANCH' from '${REMOTE}/${MAIN_BRANCH}' (if possible)..."
            if ! git merge --ff-only "${REMOTE}/${MAIN_BRANCH}" >/dev/null 2>&1; then
                print_warning "Could not fast-forward from ${REMOTE}/${MAIN_BRANCH}. Continuing with local state..."
            fi
        else
            print_warning "Fetch failed. Continuing with local state..."
        fi
    else
        print_warning "Remote '$REMOTE' not configured. Skipping update."
    fi
fi

echo ""

# Step 2: Get all local branches except main
mapfile -t branches < <(git for-each-ref --format='%(refname:short)' refs/heads | grep -v -E "^${MAIN_BRANCH}$" || true)

if [[ ${#branches[@]} -eq 0 ]]; then
    print_info "No other branches found to merge."
    exit 0
fi

print_info "Found the following branches to merge:"
for branch in "${branches[@]}"; do
    [[ -z "$branch" ]] && continue
    echo "  - $branch"
done
echo ""

# Confirmation prompt (safe default)
if [[ $ASSUME_YES -ne 1 ]]; then
    read -r -p "Proceed merging ${#branches[@]} branch(es) into '${MAIN_BRANCH}'? [y/N] " ans
    case "${ans}" in
        y|Y|yes|YES) ;;
        *) print_info "Aborted by user."; exit 0 ;;
    esac
    echo ""
fi

# Step 3: Loop through and merge each branch
for branch in "${branches[@]}"; do
    # Skip empty lines
    [ -z "$branch" ] && continue
    
    print_info "Attempting to merge '$branch' into '$MAIN_BRANCH'..."
    
    if [[ $DRY_RUN -eq 1 ]]; then
        # Attempt a non-committing merge, then abort to leave main unchanged.
        if git merge --no-commit --no-ff "$branch" >/dev/null 2>&1; then
            print_success "Dry-run merge succeeded for '$branch' (aborting to leave no changes)."
            git merge --abort >/dev/null 2>&1 || true
            successful_merges+=("$branch")
        else
            print_error "Dry-run merge failed for '$branch'. Aborting..."
            git merge --abort >/dev/null 2>&1 || true
            echo "$branch" >> "$FAILED_LOG"
            failed_merges+=("$branch")
        fi
    else
        # Attempt the merge
        if git merge "$branch" --no-edit; then
            print_success "Successfully merged '$branch'"
            successful_merges+=("$branch")
        else
            # Merge failed - abort and log
            print_error "Merge failed for '$branch'. Aborting merge..."
            git merge --abort >/dev/null 2>&1 || true
            echo "$branch" >> "$FAILED_LOG"
            failed_merges+=("$branch")
        fi
    fi
    
    echo ""
done

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

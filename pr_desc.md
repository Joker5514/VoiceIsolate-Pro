🧹 Remove unused math utility functions from param-buffer.js

🎯 **What:** Removed the unused `freqMap` and `sqrtMap` functions from `src/shared/param-buffer.js`.
💡 **Why:** To reduce dead code and improve the maintainability and readability of the codebase by keeping only the utilities that are actually needed and used.
✅ **Verification:** Verified by checking occurrences of both functions in the codebase (`grep`) and confirmed that `gainMap` is the only function currently imported and used. I also ran the project's tests and linting to ensure no regressions were introduced.
✨ **Result:** A cleaner codebase with less dead code in `param-buffer.js`.

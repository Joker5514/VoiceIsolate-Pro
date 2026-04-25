# Codebase Task Proposals

## 1) Typo fix task
**Task:** Standardize the duplicated test filename typo/inconsistency by renaming `tests/video_playback.test.js` to `tests/video-playback.test.js` (or vice versa, one convention only) and remove the duplicate suite if redundant.

**Why:** The repository currently contains both snake_case and kebab-case variants for the same domain (`video playback`), which is a naming typo/inconsistency that makes test discovery and ownership confusing.

**Evidence:** `tests/video-playback.test.js` and `tests/video_playback.test.js` both exist in the repo.

**Definition of done:**
- Only one canonical filename style is used for the video playback suite.
- Any imports/references are updated.
- CI test listing no longer shows both variants.

---

## 2) Bug fix task
**Task:** Fix malformed `package.json` scripts by removing duplicate keys (`build`, `lint`, `test`, `test:watch`) so only one intended command exists per script name.

**Why:** JSON object keys are overwritten by later entries; multiple duplicate script keys mean earlier commands are silently ignored. This can cause developers to think one command runs when another actually does.

**Evidence:** `package.json` defines `build` multiple times, and also duplicates `lint`, `test`, and `test:watch`.

**Definition of done:**
- Each script key appears exactly once in `package.json`.
- `npm run build`, `npm run lint`, and `npm test` run the documented commands.
- Add a validation check (or lint rule) to fail on duplicate keys in JSON configs.

---

## 3) Documentation discrepancy task
**Task:** Reconcile documentation paths that reference `public/blueprint/` with the actual docs layout (`public/docs/`).

**Why:** The docs currently point readers to a blueprint folder/path that is not present in the repository tree, causing broken navigation and onboarding confusion.

**Evidence:** README project structure and CONTRIBUTING file-structure/questions sections reference `public/blueprint/...`, while the repository contains `public/docs/TECHNICAL_GUIDE.md` and `public/docs/v7.5-blueprint.md`.

**Definition of done:**
- Update README and CONTRIBUTING paths to existing locations.
- Verify all internal links resolve from GitHub rendering.

---

## 4) Test improvement task
**Task:** Repair and harden `tests/utility.test.js` by fixing the malformed block comment/duplicate `describe` and adding a parser smoke test that fails on syntax errors before running unit assertions.

**Why:** The current test file has invalid syntax and duplicate suite declarations, which causes Jest/Babel parse failures and masks the actual utility-test intent.

**Evidence:** `tests/utility.test.js` contains stray comment lines inside `describe(...)` and a duplicated `describe('Utility Functions from app.js', ...)` block.

**Definition of done:**
- File parses cleanly and runs under Jest.
- Utilities assertions execute (instead of parser failing first).
- Add a lightweight syntax-check step for test files (e.g., `node --check` or eslint on `tests/**/*.js`) in CI.

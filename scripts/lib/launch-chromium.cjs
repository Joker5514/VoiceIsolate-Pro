'use strict';

/**
 * Shared Chromium launcher for the browser-driven smokes.
 *
 * Playwright resolves its browser by the revision pinned in the installed
 * `playwright` package. Sandboxes and CI images that pre-install Chromium under
 * `PLAYWRIGHT_BROWSERS_PATH` can carry a different revision, and the launch then
 * fails with "Executable doesn't exist" even though a perfectly usable Chromium
 * is on disk. `VIP_CHROMIUM_PATH` (or the conventional `<browsers>/chromium`
 * symlink) lets those environments point at the binary they actually have.
 *
 * Nothing here changes what the smokes assert — only which binary runs them.
 */

const fs = require('fs');
const path = require('path');

function resolveExecutable() {
  const explicit = process.env.VIP_CHROMIUM_PATH;
  if (explicit) {
    // A directory or socket here would surface as an opaque Playwright launch
    // error much later, so hold it to the same bar as the fallback below.
    try {
      if (fs.statSync(explicit).isFile()) return explicit;
    } catch {
      throw new Error(`VIP_CHROMIUM_PATH points at a missing file: ${explicit}`);
    }
    throw new Error(`VIP_CHROMIUM_PATH is not a regular file: ${explicit}`);
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root) {
    const link = path.join(root, 'chromium');
    // Only use it when it resolves to a file — a `chromium-<rev>` directory
    // means Playwright can find its own build and should be left alone.
    try {
      if (fs.existsSync(link) && fs.statSync(link).isFile()) return link;
    } catch { /* unreadable — fall through to Playwright's own resolution */ }
  }
  return null;
}

/** Launch Chromium, honouring a pre-installed binary when one is configured. */
async function launchChromium(options = {}) {
  const { chromium } = require('playwright');
  const executablePath = resolveExecutable();
  const args = options.args || ['--no-sandbox'];
  return chromium.launch(executablePath ? { ...options, args, executablePath } : { ...options, args });
}

module.exports = { launchChromium, resolveExecutable };

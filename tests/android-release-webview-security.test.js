/**
 * Android release WebView security regression guard.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const mainActivity = fs.readFileSync(
  path.join(__dirname, '../android/app/src/main/java/com/voiceisolatepro/app/MainActivity.java'),
  'utf8',
);

describe('Android WebView debugging', () => {
  test('is gated by BuildConfig.DEBUG rather than enabled unconditionally', () => {
    expect(mainActivity).toContain(
      'WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);',
    );
    expect(mainActivity).not.toContain(
      'WebView.setWebContentsDebuggingEnabled(true);',
    );
  });
});

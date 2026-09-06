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
const appGradle = fs.readFileSync(
  path.join(__dirname, '../android/app/build.gradle'),
  'utf8',
);

describe('Android WebView debugging', () => {
  test('generates the app BuildConfig needed by the native debug gate', () => {
    // AGP 8 disables BuildConfig generation unless the app explicitly opts in.
    expect(appGradle).toMatch(/buildFeatures\s*\{[^}]*\bbuildConfig\s+(?:=\s*)?true\b/);
  });

  test('is gated by BuildConfig.DEBUG rather than enabled unconditionally', () => {
    expect(mainActivity).toContain(
      'WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);',
    );
    expect(mainActivity).not.toContain(
      'WebView.setWebContentsDebuggingEnabled(true);',
    );
  });
});

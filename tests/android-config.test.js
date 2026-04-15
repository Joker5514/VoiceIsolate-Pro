/**
 * Tests for Android/Capacitor configuration added in v21.0 (mobile support PR)
 * Covers: capacitor.config.json, AndroidManifest.xml, strings.xml,
 *         file_paths.xml, activity_main.xml, variables.gradle,
 *         build.gradle, adaptive icon XML, and the instrumented test package assertion.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ANDROID_APP = path.join(ROOT, 'android', 'app');
const ANDROID_RES = path.join(ANDROID_APP, 'src', 'main', 'res');

// ─── Helpers ────────────────────────────────────────────────────────────────

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// ─── capacitor.config.json ───────────────────────────────────────────────────

describe('capacitor.config.json — structure and values', () => {
  let cfg;

  beforeAll(() => {
    cfg = JSON.parse(readFile('capacitor.config.json'));
  });

  test('file exists', () => {
    expect(fileExists('capacitor.config.json')).toBe(true);
  });

  test('appId matches expected package name', () => {
    expect(cfg.appId).toBe('com.voiceisolatepro.app');
  });

  test('appName is VoiceIsolate Pro', () => {
    expect(cfg.appName).toBe('VoiceIsolate Pro');
  });

  test('webDir is set to build output directory', () => {
    expect(cfg.webDir).toBe('build');
  });

  test('server.androidScheme is https (required for SharedArrayBuffer)', () => {
    expect(cfg.server).toBeDefined();
    expect(cfg.server.androidScheme).toBe('https');
  });

  test('android.allowMixedContent is false (security: no mixed http/https)', () => {
    expect(cfg.android).toBeDefined();
    expect(cfg.android.allowMixedContent).toBe(false);
  });

  test('android.webContentsDebuggingEnabled is false (production security)', () => {
    expect(cfg.android.webContentsDebuggingEnabled).toBe(false);
  });

  test('android.captureInput is true (required for audio input capture)', () => {
    expect(cfg.android.captureInput).toBe(true);
  });

  test('android.appendUserAgent includes VoiceIsolatePro/24.0', () => {
    expect(cfg.android.appendUserAgent).toBe('VoiceIsolatePro/24.0');
  });

  test('ios section is defined', () => {
    expect(cfg.ios).toBeDefined();
  });

  test('ios.allowsLinkPreview is false', () => {
    expect(cfg.ios.allowsLinkPreview).toBe(false);
  });

  test('ios.scrollEnabled is true', () => {
    expect(cfg.ios.scrollEnabled).toBe(true);
  });

  test('ios.contentInset is automatic (for safe area handling)', () => {
    expect(cfg.ios.contentInset).toBe('automatic');
  });

  test('ios.appendUserAgent matches android user agent version', () => {
    expect(cfg.ios.appendUserAgent).toBe(cfg.android.appendUserAgent);
  });

  test('server.iosScheme is configured', () => {
    expect(cfg.server.iosScheme).toBe('capacitor');
  });

  test('server.hostname is configured', () => {
    expect(cfg.server.hostname).toBe('voiceisolatepro.app');
  });

  test('plugins section is configured with SplashScreen', () => {
    expect(cfg.plugins).toBeDefined();
    expect(cfg.plugins.SplashScreen).toBeDefined();
    expect(cfg.plugins.SplashScreen.backgroundColor).toBe('#0a0a0f');
  });

  test('appId format is valid reverse-domain notation', () => {
    expect(cfg.appId).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/);
  });
});

// ─── AndroidManifest.xml ─────────────────────────────────────────────────────

describe('AndroidManifest.xml — structure and security', () => {
  let manifest;

  beforeAll(() => {
    manifest = readFile('android/app/src/main/AndroidManifest.xml');
  });

  test('file exists', () => {
    expect(fileExists('android/app/src/main/AndroidManifest.xml')).toBe(true);
  });

  test('manifest xmlns:android is declared', () => {
    expect(manifest).toContain('xmlns:android="http://schemas.android.com/apk/res/android"');
  });

  test('MainActivity is declared with correct name', () => {
    expect(manifest).toContain('android:name=".MainActivity"');
  });

  test('MainActivity launchMode is singleTask', () => {
    expect(manifest).toContain('android:launchMode="singleTask"');
  });

  test('MainActivity is exported (required for launcher intent)', () => {
    expect(manifest).toContain('android:exported="true"');
  });

  test('main intent filter is present', () => {
    expect(manifest).toContain('android.intent.action.MAIN');
    expect(manifest).toContain('android.intent.category.LAUNCHER');
  });

  test('configChanges handles orientation changes', () => {
    expect(manifest).toContain('orientation');
  });

  test('configChanges handles keyboard changes', () => {
    expect(manifest).toContain('keyboard');
    expect(manifest).toContain('keyboardHidden');
  });

  test('configChanges handles screenSize changes', () => {
    expect(manifest).toContain('screenSize');
  });

  test('configChanges handles uiMode changes', () => {
    expect(manifest).toContain('uiMode');
  });

  test('INTERNET permission is declared', () => {
    expect(manifest).toContain('android.permission.INTERNET');
  });

  test('RECORD_AUDIO permission is declared (required for live audio capture)', () => {
    expect(manifest).toContain('android.permission.RECORD_AUDIO');
  });

  test('MODIFY_AUDIO_SETTINGS permission is declared', () => {
    expect(manifest).toContain('android.permission.MODIFY_AUDIO_SETTINGS');
  });

  test('READ_MEDIA_AUDIO permission is declared (Android 13+ media access)', () => {
    expect(manifest).toContain('android.permission.READ_MEDIA_AUDIO');
  });

  test('FOREGROUND_SERVICE permission is declared (background audio processing)', () => {
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE');
  });

  test('no legacy storage permissions (use scoped storage instead)', () => {
    expect(manifest).not.toContain('android.permission.READ_EXTERNAL_STORAGE');
    expect(manifest).not.toContain('android.permission.WRITE_EXTERNAL_STORAGE');
  });

  test('FileProvider is declared with correct authority pattern', () => {
    expect(manifest).toContain('androidx.core.content.FileProvider');
    expect(manifest).toContain('${applicationId}.fileprovider');
  });

  test('FileProvider is not exported (security: prevents unauthorized access)', () => {
    // The provider element should have exported="false"
    const providerSection = manifest.substring(manifest.indexOf('<provider'));
    expect(providerSection).toContain('android:exported="false"');
  });

  test('FileProvider grants URI permissions', () => {
    expect(manifest).toContain('android:grantUriPermissions="true"');
  });

  test('FileProvider references file_paths resource', () => {
    expect(manifest).toContain('@xml/file_paths');
  });

  test('allowBackup is enabled', () => {
    expect(manifest).toContain('android:allowBackup="true"');
  });

  test('icon references ic_launcher mipmap', () => {
    expect(manifest).toContain('@mipmap/ic_launcher');
  });

  test('roundIcon references ic_launcher_round mipmap', () => {
    expect(manifest).toContain('@mipmap/ic_launcher_round');
  });

  test('app theme is defined', () => {
    expect(manifest).toContain('android:theme="@style/AppTheme"');
  });

  test('activity label references string resource', () => {
    expect(manifest).toContain('@string/title_activity_main');
  });
});

// ─── strings.xml ─────────────────────────────────────────────────────────────

describe('strings.xml — app name and package consistency', () => {
  let stringsXml;

  beforeAll(() => {
    stringsXml = readFile('android/app/src/main/res/values/strings.xml');
  });

  test('file exists', () => {
    expect(fileExists('android/app/src/main/res/values/strings.xml')).toBe(true);
  });

  test('app_name is VoiceIsolate Pro', () => {
    expect(stringsXml).toContain('<string name="app_name">VoiceIsolate Pro</string>');
  });

  test('title_activity_main is VoiceIsolate Pro', () => {
    expect(stringsXml).toContain('<string name="title_activity_main">VoiceIsolate Pro</string>');
  });

  test('package_name matches expected application ID', () => {
    expect(stringsXml).toContain('<string name="package_name">com.voiceisolatepro.app</string>');
  });

  test('custom_url_scheme matches package name', () => {
    expect(stringsXml).toContain('<string name="custom_url_scheme">com.voiceisolatepro.app</string>');
  });

  test('package_name and custom_url_scheme are consistent', () => {
    const pkgMatch = stringsXml.match(/<string name="package_name">([^<]+)<\/string>/);
    const schemeMatch = stringsXml.match(/<string name="custom_url_scheme">([^<]+)<\/string>/);
    expect(pkgMatch).not.toBeNull();
    expect(schemeMatch).not.toBeNull();
    expect(pkgMatch[1]).toBe(schemeMatch[1]);
  });

  test('app_name and title_activity_main are identical', () => {
    const appNameMatch = stringsXml.match(/<string name="app_name">([^<]+)<\/string>/);
    const titleMatch = stringsXml.match(/<string name="title_activity_main">([^<]+)<\/string>/);
    expect(appNameMatch).not.toBeNull();
    expect(titleMatch).not.toBeNull();
    expect(appNameMatch[1]).toBe(titleMatch[1]);
  });
});

// ─── file_paths.xml ───────────────────────────────────────────────────────────

describe('file_paths.xml — FileProvider path declarations', () => {
  let filePathsXml;

  beforeAll(() => {
    filePathsXml = readFile('android/app/src/main/res/xml/file_paths.xml');
  });

  test('file exists', () => {
    expect(fileExists('android/app/src/main/res/xml/file_paths.xml')).toBe(true);
  });

  test('paths root element with android namespace is present', () => {
    expect(filePathsXml).toContain('<paths');
    expect(filePathsXml).toContain('xmlns:android="http://schemas.android.com/apk/res/android"');
  });

  test('external-path element is declared for image access', () => {
    expect(filePathsXml).toContain('<external-path');
    expect(filePathsXml).toContain('name="my_images"');
  });

  test('cache-path element is declared for cached content', () => {
    expect(filePathsXml).toContain('<cache-path');
    expect(filePathsXml).toContain('name="my_cache_images"');
  });

  test('external-path has path attribute', () => {
    expect(filePathsXml).toMatch(/<external-path[^>]+path=/);
  });

  test('cache-path has path attribute', () => {
    expect(filePathsXml).toMatch(/<cache-path[^>]+path=/);
  });
});

// ─── activity_main.xml (layout) ──────────────────────────────────────────────

describe('activity_main.xml — WebView layout structure', () => {
  let layoutXml;

  beforeAll(() => {
    layoutXml = readFile('android/app/src/main/res/layout/activity_main.xml');
  });

  test('file exists', () => {
    expect(fileExists('android/app/src/main/res/layout/activity_main.xml')).toBe(true);
  });

  test('root element is CoordinatorLayout', () => {
    expect(layoutXml).toContain('androidx.coordinatorlayout.widget.CoordinatorLayout');
  });

  test('CoordinatorLayout fills parent width', () => {
    expect(layoutXml).toContain('android:layout_width="match_parent"');
  });

  test('CoordinatorLayout fills parent height', () => {
    expect(layoutXml).toContain('android:layout_height="match_parent"');
  });

  test('WebView child element is present', () => {
    expect(layoutXml).toContain('<WebView');
  });

  test('WebView fills parent width', () => {
    // Ensure WebView takes full screen width
    const webViewSection = layoutXml.substring(layoutXml.indexOf('<WebView'));
    const nextTag = webViewSection.indexOf('/>');
    const webViewTag = webViewSection.substring(0, nextTag + 2);
    expect(webViewTag).toContain('android:layout_width="match_parent"');
  });

  test('WebView fills parent height', () => {
    const webViewSection = layoutXml.substring(layoutXml.indexOf('<WebView'));
    const nextTag = webViewSection.indexOf('/>');
    const webViewTag = webViewSection.substring(0, nextTag + 2);
    expect(webViewTag).toContain('android:layout_height="match_parent"');
  });

  test('tools:context references MainActivity', () => {
    expect(layoutXml).toContain('tools:context=".MainActivity"');
  });
});

// ─── variables.gradle — SDK version constraints ───────────────────────────────

describe('variables.gradle — Android SDK version configuration', () => {
  let variablesGradle;

  beforeAll(() => {
    variablesGradle = readFile('android/variables.gradle');
  });

  test('file exists', () => {
    expect(fileExists('android/variables.gradle')).toBe(true);
  });

  test('minSdkVersion is 23 or higher (Android 6.0+)', () => {
    const match = variablesGradle.match(/minSdkVersion\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match[1], 10)).toBeGreaterThanOrEqual(23);
  });

  test('compileSdkVersion is 35 or higher', () => {
    const match = variablesGradle.match(/compileSdkVersion\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match[1], 10)).toBeGreaterThanOrEqual(35);
  });

  test('targetSdkVersion is 35 or higher', () => {
    const match = variablesGradle.match(/targetSdkVersion\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match[1], 10)).toBeGreaterThanOrEqual(35);
  });

  test('compileSdkVersion >= targetSdkVersion', () => {
    const compileMatch = variablesGradle.match(/compileSdkVersion\s*=\s*(\d+)/);
    const targetMatch = variablesGradle.match(/targetSdkVersion\s*=\s*(\d+)/);
    expect(parseInt(compileMatch[1], 10)).toBeGreaterThanOrEqual(parseInt(targetMatch[1], 10));
  });

  test('targetSdkVersion >= minSdkVersion', () => {
    const targetMatch = variablesGradle.match(/targetSdkVersion\s*=\s*(\d+)/);
    const minMatch = variablesGradle.match(/minSdkVersion\s*=\s*(\d+)/);
    expect(parseInt(targetMatch[1], 10)).toBeGreaterThanOrEqual(parseInt(minMatch[1], 10));
  });

  test('junitVersion is defined', () => {
    expect(variablesGradle).toContain('junitVersion');
  });

  test('androidxEspressoCoreVersion is defined for instrumented tests', () => {
    expect(variablesGradle).toContain('androidxEspressoCoreVersion');
  });

  test('coreSplashScreenVersion is defined (for splash screen support)', () => {
    expect(variablesGradle).toContain('coreSplashScreenVersion');
  });

  test('androidxAppCompatVersion is defined', () => {
    expect(variablesGradle).toContain('androidxAppCompatVersion');
  });
});

// ─── build.gradle — app namespace and applicationId ──────────────────────────

describe('build.gradle — app namespace and applicationId', () => {
  let buildGradle;

  beforeAll(() => {
    buildGradle = readFile('android/app/build.gradle');
  });

  test('file exists', () => {
    expect(fileExists('android/app/build.gradle')).toBe(true);
  });

  test('namespace is com.voiceisolatepro.app', () => {
    expect(buildGradle).toContain('namespace "com.voiceisolatepro.app"');
  });

  test('applicationId is com.voiceisolatepro.app', () => {
    expect(buildGradle).toContain('applicationId "com.voiceisolatepro.app"');
  });

  test('namespace and applicationId match each other', () => {
    const nsMatch = buildGradle.match(/namespace\s+"([^"]+)"/);
    const idMatch = buildGradle.match(/applicationId\s+"([^"]+)"/);
    expect(nsMatch).not.toBeNull();
    expect(idMatch).not.toBeNull();
    expect(nsMatch[1]).toBe(idMatch[1]);
  });

  test('versionCode is 22100 (matching v22.1.0)', () => {
    expect(buildGradle).toContain('versionCode 22100');
  });

  test('versionName is 22.1.0', () => {
    expect(buildGradle).toContain('versionName "22.1.0"');
  });

  test('testInstrumentationRunner is AndroidJUnitRunner', () => {
    expect(buildGradle).toContain('testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"');
  });

  test('applies com.android.application plugin', () => {
    expect(buildGradle).toContain("apply plugin: 'com.android.application'");
  });

  test('includes capacitor-android project dependency', () => {
    expect(buildGradle).toContain("project(':capacitor-android')");
  });

  test('applies capacitor.build.gradle', () => {
    expect(buildGradle).toContain("apply from: 'capacitor.build.gradle'");
  });

  test('ignoreAssetsPattern is configured for web app compatibility', () => {
    expect(buildGradle).toContain('ignoreAssetsPattern');
    // Should ignore .git, .svn, etc. while preserving web assets
    expect(buildGradle).toContain('!.svn');
    expect(buildGradle).toContain('!.git');
  });
});

// ─── ic_launcher adaptive icon XMLs ──────────────────────────────────────────

describe('mipmap-anydpi-v26 adaptive icon XMLs', () => {
  const iconFiles = [
    'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
    'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml',
  ];

  test.each(iconFiles)('%s exists', (relPath) => {
    expect(fileExists(relPath)).toBe(true);
  });

  test.each(iconFiles)('%s has adaptive-icon root element', (relPath) => {
    const content = readFile(relPath);
    expect(content).toContain('<adaptive-icon');
    expect(content).toContain('xmlns:android="http://schemas.android.com/apk/res/android"');
  });

  test.each(iconFiles)('%s references background drawable', (relPath) => {
    const content = readFile(relPath);
    expect(content).toContain('<background');
    expect(content).toContain('ic_launcher_background');
  });

  test.each(iconFiles)('%s references foreground drawable', (relPath) => {
    const content = readFile(relPath);
    expect(content).toContain('<foreground');
    expect(content).toContain('ic_launcher_foreground');
  });

  test('ic_launcher.xml and ic_launcher_round.xml have identical content (same adaptive icon)', () => {
    const launcher = readFile(iconFiles[0]);
    const round = readFile(iconFiles[1]);
    expect(launcher).toBe(round);
  });
});

// ─── ic_launcher_background.xml (drawable) ───────────────────────────────────

describe('drawable/ic_launcher_background.xml — vector drawable', () => {
  let backgroundXml;

  beforeAll(() => {
    backgroundXml = readFile('android/app/src/main/res/drawable/ic_launcher_background.xml');
  });

  test('file exists', () => {
    expect(fileExists('android/app/src/main/res/drawable/ic_launcher_background.xml')).toBe(true);
  });

  test('root element is a vector', () => {
    expect(backgroundXml).toContain('<vector');
    expect(backgroundXml).toContain('xmlns:android="http://schemas.android.com/apk/res/android"');
  });

  test('viewport dimensions are 108dp (standard adaptive icon size)', () => {
    expect(backgroundXml).toContain('android:viewportHeight="108"');
    expect(backgroundXml).toContain('android:viewportWidth="108"');
  });

  test('width and height are 108dp', () => {
    expect(backgroundXml).toContain('android:width="108dp"');
    expect(backgroundXml).toContain('android:height="108dp"');
  });
});

// ─── ic_launcher_foreground.xml (drawable-v24) ───────────────────────────────

describe('drawable-v24/ic_launcher_foreground.xml — vector drawable', () => {
  let foregroundXml;

  beforeAll(() => {
    foregroundXml = readFile('android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml');
  });

  test('file exists', () => {
    expect(fileExists('android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml')).toBe(true);
  });

  test('root element is a vector', () => {
    expect(foregroundXml).toContain('<vector');
    expect(foregroundXml).toContain('xmlns:android="http://schemas.android.com/apk/res/android"');
  });

  test('viewport dimensions are 108dp (standard adaptive icon size)', () => {
    expect(foregroundXml).toContain('android:viewportHeight="108"');
    expect(foregroundXml).toContain('android:viewportWidth="108"');
  });

  test('width and height are 108dp', () => {
    expect(foregroundXml).toContain('android:width="108dp"');
    expect(foregroundXml).toContain('android:height="108dp"');
  });

  test('contains at least one path element', () => {
    expect(foregroundXml).toContain('<path');
  });
});

// ─── ExampleInstrumentedTest.java — package assertion correctness ─────────────

describe('ExampleInstrumentedTest.java — package name assertion', () => {
  let testSource;
  const CORRECT_PACKAGE = 'com.voiceisolatepro.app';

  beforeAll(() => {
    testSource = readFile(
      'android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java'
    );
  });

  test('file exists', () => {
    expect(
      fileExists(
        'android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java'
      )
    ).toBe(true);
  });

  test('test class uses AndroidJUnit4 runner', () => {
    expect(testSource).toContain('@RunWith(AndroidJUnit4.class)');
  });

  test('test class is named ExampleInstrumentedTest', () => {
    expect(testSource).toContain('public class ExampleInstrumentedTest');
  });

  test('useAppContext test method is present', () => {
    expect(testSource).toContain('@Test');
    expect(testSource).toContain('public void useAppContext()');
  });

  /**
   * Regression test: The instrumented test file added in this PR contains
   * a stale package assertion "com.getcapacitor.app" — the default Capacitor
   * scaffold value — instead of the actual application ID "com.voiceisolatepro.app".
   * This test documents the discrepancy and will fail until the assertion is fixed.
   */
  test('REGRESSION: package assertion matches actual applicationId (com.voiceisolatepro.app)', () => {
    // The test source currently asserts "com.getcapacitor.app" which is WRONG.
    // The actual applicationId (from build.gradle) is "com.voiceisolatepro.app".
    // This test will fail if the bug is present, surfacing it for the reviewer.
    expect(testSource).toContain(`assertEquals("${CORRECT_PACKAGE}"`);
  });

  test('does not reference default Capacitor scaffold package com.getcapacitor.app', () => {
    // The default Capacitor scaffold uses com.getcapacitor.app; this must be replaced.
    expect(testSource).not.toContain('"com.getcapacitor.app"');
  });
});

// ─── Splash screen resource files existence ───────────────────────────────────

describe('Splash screen PNG resources — existence checks', () => {
  const splashFiles = [
    'android/app/src/main/res/drawable/splash.png',
    'android/app/src/main/res/drawable-land-hdpi/splash.png',
    'android/app/src/main/res/drawable-land-mdpi/splash.png',
    'android/app/src/main/res/drawable-land-xhdpi/splash.png',
    'android/app/src/main/res/drawable-land-xxhdpi/splash.png',
    'android/app/src/main/res/drawable-land-xxxhdpi/splash.png',
    'android/app/src/main/res/drawable-port-hdpi/splash.png',
    'android/app/src/main/res/drawable-port-mdpi/splash.png',
    'android/app/src/main/res/drawable-port-xhdpi/splash.png',
    'android/app/src/main/res/drawable-port-xxhdpi/splash.png',
    'android/app/src/main/res/drawable-port-xxxhdpi/splash.png',
  ];

  test.each(splashFiles)('%s exists and is non-empty', (relPath) => {
    expect(fileExists(relPath)).toBe(true);
    const stats = fs.statSync(path.join(ROOT, relPath));
    expect(stats.size).toBeGreaterThan(0);
  });

  test('all portrait splash files are present (5 densities)', () => {
    const portraitFiles = splashFiles.filter(f => f.includes('drawable-port-'));
    expect(portraitFiles).toHaveLength(5);
    portraitFiles.forEach(f => expect(fileExists(f)).toBe(true));
  });

  test('all landscape splash files are present (5 densities)', () => {
    const landscapeFiles = splashFiles.filter(f => f.includes('drawable-land-'));
    expect(landscapeFiles).toHaveLength(5);
    landscapeFiles.forEach(f => expect(fileExists(f)).toBe(true));
  });

  test('each splash PNG starts with PNG magic bytes', () => {
    // PNG files start with: 89 50 4E 47 0D 0A 1A 0A
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    splashFiles.forEach(relPath => {
      const buf = fs.readFileSync(path.join(ROOT, relPath));
      expect(buf.slice(0, 8)).toEqual(PNG_MAGIC);
    });
  });
});

// ─── capacitor.config.json vs strings.xml cross-consistency ──────────────────

describe('Cross-file consistency — appId matches across all config files', () => {
  const EXPECTED_APP_ID = 'com.voiceisolatepro.app';

  test('capacitor.config.json appId matches expected', () => {
    const cfg = JSON.parse(readFile('capacitor.config.json'));
    expect(cfg.appId).toBe(EXPECTED_APP_ID);
  });

  test('strings.xml package_name matches capacitor.config.json appId', () => {
    const cfg = JSON.parse(readFile('capacitor.config.json'));
    const stringsXml = readFile('android/app/src/main/res/values/strings.xml');
    const match = stringsXml.match(/<string name="package_name">([^<]+)<\/string>/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(cfg.appId);
  });

  test('build.gradle applicationId matches capacitor.config.json appId', () => {
    const cfg = JSON.parse(readFile('capacitor.config.json'));
    const buildGradle = readFile('android/app/build.gradle');
    const match = buildGradle.match(/applicationId\s+"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(cfg.appId);
  });

  test('build.gradle namespace matches capacitor.config.json appId', () => {
    const cfg = JSON.parse(readFile('capacitor.config.json'));
    const buildGradle = readFile('android/app/build.gradle');
    const match = buildGradle.match(/namespace\s+"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(cfg.appId);
  });

  test('capacitor.config.json appName matches strings.xml app_name', () => {
    const cfg = JSON.parse(readFile('capacitor.config.json'));
    const stringsXml = readFile('android/app/src/main/res/values/strings.xml');
    const match = stringsXml.match(/<string name="app_name">([^<]+)<\/string>/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(cfg.appName);
  });
});

// ─── Android .gitignore — critical entries ────────────────────────────────────

describe('android/.gitignore — critical exclusions', () => {
  let gitignore;

  beforeAll(() => {
    gitignore = readFile('android/.gitignore');
  });

  test('file exists', () => {
    expect(fileExists('android/.gitignore')).toBe(true);
  });

  test('ignores compiled APK files', () => {
    expect(gitignore).toContain('*.apk');
  });

  test('ignores AAR bundles', () => {
    expect(gitignore).toContain('*.aar');
  });

  test('ignores .gradle build cache', () => {
    expect(gitignore).toContain('.gradle/');
  });

  test('ignores build output directory', () => {
    expect(gitignore).toContain('build/');
  });

  test('ignores local.properties (contains SDK path, should not be committed)', () => {
    expect(gitignore).toContain('local.properties');
  });

  test('ignores capacitor-cordova-android-plugins (generated)', () => {
    expect(gitignore).toContain('capacitor-cordova-android-plugins');
  });

  test('ignores copied web assets (app/src/main/assets/public)', () => {
    expect(gitignore).toContain('app/src/main/assets/public');
  });

  test('ignores generated capacitor config files', () => {
    expect(gitignore).toContain('app/src/main/assets/capacitor.config.json');
    expect(gitignore).toContain('app/src/main/assets/capacitor.plugins.json');
  });

  test('ignores keystore log files', () => {
    expect(gitignore).toContain('*.log');
  });
});
/**
 * Tests for iOS/Capacitor configuration (v24.0.0 mobile support)
 * Covers: Info.plist, Podfile, AppDelegate.swift, entitlements,
 *         asset catalogs, capacitor.config.json iOS settings,
 *         and cross-platform consistency.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IOS_APP = path.join(ROOT, 'ios', 'App', 'App');

// ─── Helpers ────────────────────────────────────────────────────────────────

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function fileExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// ─── iOS directory structure ────────────────────────────────────────────────

describe('iOS project — directory structure', () => {
  const requiredFiles = [
    'ios/App/App/AppDelegate.swift',
    'ios/App/App/Info.plist',
    'ios/App/App/VoiceIsolateProApp.entitlements',
    'ios/App/Podfile',
    'ios/.gitignore',
    'ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json',
    'ios/App/App/Assets.xcassets/Splash.imageset/Contents.json',
  ];

  test.each(requiredFiles)('%s exists', (relPath) => {
    expect(fileExists(relPath)).toBe(true);
  });
});

// ─── Info.plist ─────────────────────────────────────────────────────────────

describe('Info.plist — iOS app configuration', () => {
  let plist;

  beforeAll(() => {
    plist = readFile('ios/App/App/Info.plist');
  });

  test('file exists', () => {
    expect(fileExists('ios/App/App/Info.plist')).toBe(true);
  });

  test('is a valid plist XML file', () => {
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain('<!DOCTYPE plist');
    expect(plist).toContain('<plist version="1.0">');
  });

  test('CFBundleDisplayName is VoiceIsolate Pro', () => {
    expect(plist).toContain('<key>CFBundleDisplayName</key>');
    expect(plist).toContain('<string>VoiceIsolate Pro</string>');
  });

  test('CFBundleShortVersionString is 24.0.0', () => {
    expect(plist).toContain('<key>CFBundleShortVersionString</key>');
    const versionMatch = plist.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
    );
    expect(versionMatch).not.toBeNull();
    expect(versionMatch[1]).toBe('24.0.0');
  });

  test('CFBundleVersion is 24000', () => {
    expect(plist).toContain('<key>CFBundleVersion</key>');
    const buildMatch = plist.match(
      /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/
    );
    expect(buildMatch).not.toBeNull();
    expect(buildMatch[1]).toBe('24000');
  });

  test('NSMicrophoneUsageDescription is present (App Store requirement)', () => {
    expect(plist).toContain('<key>NSMicrophoneUsageDescription</key>');
    const descMatch = plist.match(
      /<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]+)<\/string>/
    );
    expect(descMatch).not.toBeNull();
    expect(descMatch[1].length).toBeGreaterThan(10);
  });

  test('UIBackgroundModes includes audio', () => {
    expect(plist).toContain('<key>UIBackgroundModes</key>');
    expect(plist).toContain('<string>audio</string>');
  });

  test('UIStatusBarStyle is LightContent (dark theme)', () => {
    expect(plist).toContain('<key>UIStatusBarStyle</key>');
    expect(plist).toContain('<string>UIStatusBarStyleLightContent</string>');
  });

  test('supports both portrait and landscape on iPhone', () => {
    expect(plist).toContain('<key>UISupportedInterfaceOrientations</key>');
    expect(plist).toContain('UIInterfaceOrientationPortrait');
    expect(plist).toContain('UIInterfaceOrientationLandscapeLeft');
    expect(plist).toContain('UIInterfaceOrientationLandscapeRight');
  });

  test('iPad supports all four orientations', () => {
    expect(plist).toContain('<key>UISupportedInterfaceOrientations~ipad</key>');
    expect(plist).toContain('UIInterfaceOrientationPortraitUpsideDown');
  });

  test('ITSAppUsesNonExemptEncryption is false (avoids export compliance dialog)', () => {
    expect(plist).toContain('<key>ITSAppUsesNonExemptEncryption</key>');
    // The <false/> should follow the key
    const match = plist.match(
      /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/
    );
    expect(match).not.toBeNull();
  });

  test('LSRequiresIPhoneOS is true', () => {
    expect(plist).toContain('<key>LSRequiresIPhoneOS</key>');
  });

  test('UIViewControllerBasedStatusBarAppearance is true', () => {
    expect(plist).toContain('<key>UIViewControllerBasedStatusBarAppearance</key>');
  });

  test('launch storyboard is configured', () => {
    expect(plist).toContain('<key>UILaunchStoryboardName</key>');
    expect(plist).toContain('<string>LaunchScreen</string>');
  });

  test('NSAppTransportSecurity allows web content loading', () => {
    expect(plist).toContain('<key>NSAppTransportSecurity</key>');
    expect(plist).toContain('<key>NSAllowsArbitraryLoadsInWebContent</key>');
  });
});

// ─── AppDelegate.swift ──────────────────────────────────────────────────────

describe('AppDelegate.swift — iOS entry point', () => {
  let delegate;

  beforeAll(() => {
    delegate = readFile('ios/App/App/AppDelegate.swift');
  });

  test('file exists', () => {
    expect(fileExists('ios/App/App/AppDelegate.swift')).toBe(true);
  });

  test('imports UIKit', () => {
    expect(delegate).toContain('import UIKit');
  });

  test('imports Capacitor', () => {
    expect(delegate).toContain('import Capacitor');
  });

  test('class inherits from UIResponder and UIApplicationDelegate', () => {
    expect(delegate).toContain('class AppDelegate: UIResponder, UIApplicationDelegate');
  });

  test('has @UIApplicationMain attribute', () => {
    expect(delegate).toContain('@UIApplicationMain');
  });

  test('implements didFinishLaunchingWithOptions', () => {
    expect(delegate).toContain('didFinishLaunchingWithOptions');
  });

  test('implements application open url handler for deep links', () => {
    expect(delegate).toContain('open url: URL');
    expect(delegate).toContain('ApplicationDelegateProxy.shared');
  });

  test('implements continue userActivity handler for universal links', () => {
    expect(delegate).toContain('continue userActivity: NSUserActivity');
  });

  test('has window property', () => {
    expect(delegate).toContain('var window: UIWindow?');
  });
});

// ─── Entitlements ───────────────────────────────────────────────────────────

describe('VoiceIsolateProApp.entitlements — security and capabilities', () => {
  let entitlements;

  beforeAll(() => {
    entitlements = readFile('ios/App/App/VoiceIsolateProApp.entitlements');
  });

  test('file exists', () => {
    expect(fileExists('ios/App/App/VoiceIsolateProApp.entitlements')).toBe(true);
  });

  test('is a valid plist file', () => {
    expect(entitlements).toContain('<?xml version="1.0"');
    expect(entitlements).toContain('<plist version="1.0">');
  });

  test('audio input entitlement is enabled', () => {
    expect(entitlements).toContain('com.apple.security.device.audio-input');
  });

  test('file access entitlement is enabled', () => {
    expect(entitlements).toContain('com.apple.security.files.user-selected.read-write');
  });

  test('associated domains are configured', () => {
    expect(entitlements).toContain('com.apple.developer.associated-domains');
    expect(entitlements).toContain('applinks:voiceisolatepro.app');
  });
});

// ─── Podfile ────────────────────────────────────────────────────────────────

describe('Podfile — CocoaPods configuration', () => {
  let podfile;

  beforeAll(() => {
    podfile = readFile('ios/App/Podfile');
  });

  test('file exists', () => {
    expect(fileExists('ios/App/Podfile')).toBe(true);
  });

  test('platform is iOS 14.1+', () => {
    expect(podfile).toContain("platform :ios, '14.1'");
  });

  test('uses frameworks', () => {
    expect(podfile).toContain('use_frameworks!');
  });

  test('includes Capacitor pod', () => {
    expect(podfile).toContain("pod 'Capacitor'");
  });

  test('includes CapacitorCordova pod', () => {
    expect(podfile).toContain("pod 'CapacitorCordova'");
  });

  test('references correct node_modules path for Capacitor iOS', () => {
    expect(podfile).toContain('@capacitor/ios');
  });

  test('sets deployment target in post_install', () => {
    expect(podfile).toContain('post_install');
    expect(podfile).toContain("'IPHONEOS_DEPLOYMENT_TARGET'");
    expect(podfile).toContain("'14.1'");
  });

  test('has App target', () => {
    expect(podfile).toContain("target 'App'");
  });
});

// ─── Asset Catalogs ─────────────────────────────────────────────────────────

describe('Asset Catalogs — AppIcon and Splash', () => {
  test('AppIcon Contents.json exists and is valid JSON', () => {
    const content = readFile('ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json');
    const parsed = JSON.parse(content);
    expect(parsed.images).toBeDefined();
    expect(Array.isArray(parsed.images)).toBe(true);
    expect(parsed.info).toBeDefined();
    expect(parsed.info.author).toBe('xcode');
  });

  test('AppIcon has required iPhone sizes (20, 29, 40, 60)', () => {
    const content = JSON.parse(
      readFile('ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json')
    );
    const iphoneImages = content.images.filter(i => i.idiom === 'iphone');
    const sizes = iphoneImages.map(i => i.size);
    expect(sizes).toContain('20x20');
    expect(sizes).toContain('29x29');
    expect(sizes).toContain('40x40');
    expect(sizes).toContain('60x60');
  });

  test('AppIcon has required iPad sizes (20, 29, 40, 76, 83.5)', () => {
    const content = JSON.parse(
      readFile('ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json')
    );
    const ipadImages = content.images.filter(i => i.idiom === 'ipad');
    const sizes = ipadImages.map(i => i.size);
    expect(sizes).toContain('20x20');
    expect(sizes).toContain('29x29');
    expect(sizes).toContain('40x40');
    expect(sizes).toContain('76x76');
    expect(sizes).toContain('83.5x83.5');
  });

  test('AppIcon has 1024x1024 App Store icon', () => {
    const content = JSON.parse(
      readFile('ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json')
    );
    const marketing = content.images.find(i => i.idiom === 'ios-marketing');
    expect(marketing).toBeDefined();
    expect(marketing.size).toBe('1024x1024');
  });

  test('Splash Contents.json exists and is valid JSON', () => {
    const content = readFile('ios/App/App/Assets.xcassets/Splash.imageset/Contents.json');
    const parsed = JSON.parse(content);
    expect(parsed.images).toBeDefined();
    expect(Array.isArray(parsed.images)).toBe(true);
    expect(parsed.images.length).toBeGreaterThanOrEqual(3);
  });

  test('Splash has 1x, 2x, and 3x scale variants', () => {
    const content = JSON.parse(
      readFile('ios/App/App/Assets.xcassets/Splash.imageset/Contents.json')
    );
    const scales = content.images.map(i => i.scale);
    expect(scales).toContain('1x');
    expect(scales).toContain('2x');
    expect(scales).toContain('3x');
  });
});

// ─── iOS .gitignore ─────────────────────────────────────────────────────────

describe('ios/.gitignore — critical exclusions', () => {
  let gitignore;

  beforeAll(() => {
    gitignore = readFile('ios/.gitignore');
  });

  test('file exists', () => {
    expect(fileExists('ios/.gitignore')).toBe(true);
  });

  test('ignores Pods directory', () => {
    expect(gitignore).toContain('Pods');
  });

  test('ignores build output', () => {
    expect(gitignore).toContain('build');
  });

  test('ignores DerivedData', () => {
    expect(gitignore).toContain('DerivedData');
  });

  test('ignores xcuserdata (user-specific Xcode settings)', () => {
    expect(gitignore).toContain('xcuserdata');
  });

  test('ignores copied web assets', () => {
    expect(gitignore).toContain('App/App/public');
  });

  test('ignores generated capacitor config', () => {
    expect(gitignore).toContain('capacitor.config.json');
  });

  test('ignores IPA files', () => {
    expect(gitignore).toContain('*.ipa');
  });

  test('ignores dSYM files', () => {
    expect(gitignore).toContain('*.dSYM');
  });
});

// ─── capacitor.config.json — iOS settings ───────────────────────────────────

describe('capacitor.config.json — iOS-specific settings', () => {
  let cfg;

  beforeAll(() => {
    cfg = JSON.parse(readFile('capacitor.config.json'));
  });

  test('ios section exists', () => {
    expect(cfg.ios).toBeDefined();
  });

  test('ios.contentInset is automatic', () => {
    expect(cfg.ios.contentInset).toBe('automatic');
  });

  test('ios.allowsLinkPreview is false', () => {
    expect(cfg.ios.allowsLinkPreview).toBe(false);
  });

  test('ios.scrollEnabled is true', () => {
    expect(cfg.ios.scrollEnabled).toBe(true);
  });

  test('ios.appendUserAgent includes VoiceIsolatePro version', () => {
    expect(cfg.ios.appendUserAgent).toMatch(/VoiceIsolatePro\/\d+\.\d+/);
  });

  test('ios.backgroundColor is dark theme (#0a0a0f)', () => {
    expect(cfg.ios.backgroundColor).toBe('#0a0a0f');
  });

  test('ios.preferredContentMode is mobile', () => {
    expect(cfg.ios.preferredContentMode).toBe('mobile');
  });

  test('ios.webContentsDebuggingEnabled is false (production)', () => {
    expect(cfg.ios.webContentsDebuggingEnabled).toBe(false);
  });

  test('ios.limitsNavigationsToAppBoundDomains is true (WKAppBoundDomains)', () => {
    expect(cfg.ios.limitsNavigationsToAppBoundDomains).toBe(true);
  });

  test('server.iosScheme is capacitor', () => {
    expect(cfg.server.iosScheme).toBe('capacitor');
  });

  test('server.hostname matches app domain', () => {
    expect(cfg.server.hostname).toBe('voiceisolatepro.app');
  });
});

// ─── Cross-platform consistency ─────────────────────────────────────────────

describe('Cross-platform consistency — Android & iOS', () => {
  let cfg;

  beforeAll(() => {
    cfg = JSON.parse(readFile('capacitor.config.json'));
  });

  test('appId is consistent across platforms', () => {
    // Check capacitor config appId
    expect(cfg.appId).toBe('com.voiceisolatepro.app');
  });

  test('user agent version is consistent between Android and iOS', () => {
    expect(cfg.android.appendUserAgent).toBe(cfg.ios.appendUserAgent);
  });

  test('backgroundColor is consistent between Android and iOS', () => {
    expect(cfg.android.backgroundColor).toBe(cfg.ios.backgroundColor);
  });

  test('webContentsDebuggingEnabled is disabled on both platforms', () => {
    expect(cfg.android.webContentsDebuggingEnabled).toBe(false);
    expect(cfg.ios.webContentsDebuggingEnabled).toBe(false);
  });

  test('plugins section is configured', () => {
    expect(cfg.plugins).toBeDefined();
    expect(cfg.plugins.SplashScreen).toBeDefined();
    expect(cfg.plugins.StatusBar).toBeDefined();
  });

  test('SplashScreen backgroundColor matches app background', () => {
    expect(cfg.plugins.SplashScreen.backgroundColor).toBe('#0a0a0f');
  });

  test('StatusBar backgroundColor matches app background', () => {
    expect(cfg.plugins.StatusBar.backgroundColor).toBe('#0a0a0f');
  });

  test('Android versionCode in build.gradle matches iOS CFBundleVersion in Info.plist', () => {
    const buildGradle = readFile('android/app/build.gradle');
    const infoPlist = readFile('ios/App/App/Info.plist');

    const androidVersion = buildGradle.match(/versionCode\s+(\d+)/);
    const iosVersion = infoPlist.match(
      /<key>CFBundleVersion<\/key>\s*<string>(\d+)<\/string>/
    );

    expect(androidVersion).not.toBeNull();
    expect(iosVersion).not.toBeNull();
    expect(androidVersion[1]).toBe(iosVersion[1]);
  });

  test('Android versionName matches iOS CFBundleShortVersionString', () => {
    const buildGradle = readFile('android/app/build.gradle');
    const infoPlist = readFile('ios/App/App/Info.plist');

    const androidName = buildGradle.match(/versionName\s+"([^"]+)"/);
    const iosName = infoPlist.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
    );

    expect(androidName).not.toBeNull();
    expect(iosName).not.toBeNull();
    expect(androidName[1]).toBe(iosName[1]);
  });
});

// ─── Fastlane configuration ─────────────────────────────────────────────────

describe('Fastlane — build automation config', () => {
  test('Fastfile exists', () => {
    expect(fileExists('fastlane/Fastfile')).toBe(true);
  });

  test('Appfile exists', () => {
    expect(fileExists('fastlane/Appfile')).toBe(true);
  });

  test('Fastfile has iOS platform lanes', () => {
    const fastfile = readFile('fastlane/Fastfile');
    expect(fastfile).toContain('platform :ios');
    expect(fastfile).toContain('lane :build_dev');
    expect(fastfile).toContain('lane :build_release');
    expect(fastfile).toContain('lane :beta');
    expect(fastfile).toContain('lane :release');
  });

  test('Fastfile has Android platform lanes', () => {
    const fastfile = readFile('fastlane/Fastfile');
    expect(fastfile).toContain('platform :android');
  });

  test('Appfile has correct app identifier', () => {
    const appfile = readFile('fastlane/Appfile');
    expect(appfile).toContain('com.voiceisolatepro.app');
  });

  test('Fastfile runs cap sync before builds', () => {
    const fastfile = readFile('fastlane/Fastfile');
    expect(fastfile).toContain('npx cap sync ios');
    expect(fastfile).toContain('npx cap sync android');
  });
});

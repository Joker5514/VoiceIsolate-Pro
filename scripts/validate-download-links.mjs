#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const REPO = 'Joker5514/VoiceIsolate-Pro';
const GITHUB_API = `https://api.github.com/repos/${REPO}`;
const PROD = 'https://voice-isolate-pro.vercel.app';
const TIMEOUT_MS = 15_000;
const RETRIES = 2;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const apkName = 'VoiceIsolate-Pro-android-debug.apk';
const exeName = `VoiceIsolate-Pro-${version}-win-x64.exe`;
const pinnedApk = `https://github.com/${REPO}/releases/download/${tag}/${apkName}`;
const pinnedExe = `https://github.com/${REPO}/releases/download/${tag}/${exeName}`;
const latestApk = `https://github.com/${REPO}/releases/latest/download/${apkName}`;
const latestExe = `https://github.com/${REPO}/releases/latest/download/${exeName}`;

function fail(message) {
  throw new Error(message);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function requestHeaders(url, extra = {}) {
  const target = new URL(url);
  const out = {
    'User-Agent': 'VoiceIsolate-Pro-download-validator',
    ...extra,
  };
  if (target.hostname === 'api.github.com') {
    out.Accept = out.Accept || 'application/vnd.github+json';
    if (process.env.GITHUB_TOKEN) {
      out.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
  }
  return out;
}

async function request(url, options = {}, label = url) {
  let lastError;
  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: requestHeaders(url, options.headers || {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return response;
    } catch (error) {
      lastError = error;
      if (attempt <= RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
      }
    }
  }
  fail(`${label}: request failed after retries: ${lastError?.message || lastError}`);
}

function assertRouteStatus(response, label) {
  assert(response.status >= 200 && response.status < 400, `${label}: HTTP ${response.status}`);
}

function assetByName(release, name) {
  const asset = release.assets?.find((entry) => entry.name === name);
  assert(asset, `GitHub release ${release.tag_name} is missing ${name}`);
  assert(asset.state === 'uploaded', `${name}: expected uploaded state, got ${asset.state}`);
  assert(Number.isInteger(asset.size) && asset.size > 0, `${name}: invalid size ${asset.size}`);
  assert(/^sha256:[0-9a-f]{64}$/.test(asset.digest || ''), `${name}: missing/invalid SHA-256 digest`);
  return asset;
}

async function validateGitHubRelease() {
  const response = await request(`${GITHUB_API}/releases/latest`, {}, 'GitHub latest release API');
  assert(response.ok, `GitHub latest release API: HTTP ${response.status}`);
  const release = await response.json();
  assert(release.tag_name === tag, `Latest release ${release.tag_name} does not match package version ${tag}`);
  assert(release.draft === false, 'Latest release must not be draft');
  assert(release.prerelease === false, 'Latest release must not be prerelease');

  const apk = assetByName(release, apkName);
  const exe = assetByName(release, exeName);

  assert(apk.browser_download_url === pinnedApk, `${apkName}: unexpected pinned URL`);
  assert(exe.browser_download_url === pinnedExe, `${exeName}: unexpected pinned URL`);
  assert(apk.content_type === 'application/vnd.android.package-archive', `${apkName}: unexpected content type ${apk.content_type}`);
  assert(
    ['application/x-msdownload', 'application/octet-stream'].includes(exe.content_type),
    `${exeName}: unexpected content type ${exe.content_type}`,
  );

  return { release, apk, exe };
}

function validateRepositoryReferences({ apk, exe }) {
  const currentDocs = [
    'README.md',
    'download/README.md',
    'docs/DOWNLOADS.md',
    'docs/guides/ANDROID.md',
    'docs/guides/electron-desktop.md',
    'docs/releases/PLATFORM_SYNC.md',
    'public/download/index.html',
  ];

  const combined = currentDocs.map((rel) => `\n--- ${rel} ---\n${read(rel)}`).join('\n');
  for (const required of [latestApk, pinnedApk, latestExe, pinnedExe]) {
    assert(combined.includes(required), `Current documentation does not contain required URL: ${required}`);
  }

  for (const rel of currentDocs) {
    const text = read(rel);
    assert(
      !text.includes('/releases/download/v24.0.0/'),
      `${rel}: current documentation must not foreground v24.0.0 direct downloads; use the Releases archive instead`,
    );
  }

  const publicDownload = read('public/download/index.html');
  assert(publicDownload.includes(String(apk.size)), 'Download page APK byte size does not match GitHub release');
  assert(publicDownload.includes(apk.digest.slice('sha256:'.length)), 'Download page APK digest does not match GitHub release');
  assert(publicDownload.includes(String(exe.size)), 'Download page Windows byte size does not match GitHub release');
  assert(publicDownload.includes(exe.digest.slice('sha256:'.length)), 'Download page Windows digest does not match GitHub release');

  const vercel = JSON.parse(read('vercel.json'));
  const redirects = Array.isArray(vercel.redirects) ? vercel.redirects : [];
  const expected = new Map([
    [`/download/${apkName}`, latestApk],
    [`/download/${exeName}`, latestExe],
  ]);
  for (const [source, destination] of expected) {
    const match = redirects.find((entry) => entry.source === source);
    assert(match, `vercel.json is missing redirect ${source}`);
    assert(match.destination === destination, `${source}: redirect destination is stale`);
  }

  const provenance = JSON.parse(read('docs/releases/release-provenance.json'));
  assert(provenance.productVersion === version, 'release-provenance productVersion does not match package.json');
  assert(provenance.tag === tag, 'release-provenance tag does not match package.json');
  const android = provenance.platforms?.find((entry) => entry.platform === 'android');
  const windows = provenance.platforms?.find((entry) => entry.platform === 'windows');
  assert(android, 'release-provenance is missing android record');
  assert(windows, 'release-provenance is missing windows record');

  for (const [record, asset, expectedName, expectedUrl] of [
    [android, apk, apkName, pinnedApk],
    [windows, exe, exeName, pinnedExe],
  ]) {
    assert(record.artifact?.filename === expectedName, `${record.platform}: provenance filename mismatch`);
    assert(record.artifact?.url === expectedUrl, `${record.platform}: provenance URL mismatch`);
    assert(record.artifact?.sizeBytes === asset.size, `${record.platform}: provenance size does not match GitHub release`);
    assert(record.artifact?.sha256 === asset.digest.slice('sha256:'.length), `${record.platform}: provenance digest does not match GitHub release`);
  }
}

async function validateLiveRoutes() {
  for (const pathname of ['/', '/app/', '/download/']) {
    const response = await request(`${PROD}${pathname}`, { redirect: 'follow' }, `Production ${pathname}`);
    assertRouteStatus(response, `Production ${pathname}`);
    await response.body?.cancel?.();
  }

  for (const [label, url] of [
    ['Android latest', latestApk],
    ['Windows latest', latestExe],
    ['Android pinned', pinnedApk],
    ['Windows pinned', pinnedExe],
  ]) {
    const response = await request(url, { method: 'HEAD', redirect: 'manual' }, label);
    assertRouteStatus(response, label);
    assert(response.status !== 404, `${label}: download URL returned 404`);
    await response.body?.cancel?.();
  }

  for (const [label, pathname] of [
    ['Vercel Android redirect', `/download/${apkName}`],
    ['Vercel Windows redirect', `/download/${exeName}`],
  ]) {
    const response = await request(`${PROD}${pathname}`, { method: 'HEAD', redirect: 'manual' }, label);
    assertRouteStatus(response, label);
    assert(response.status !== 404, `${label}: route returned 404`);
    await response.body?.cancel?.();
  }
}

async function main() {
  console.log(`[downloads] validating VoiceIsolate Pro ${tag}`);
  const observed = await validateGitHubRelease();
  validateRepositoryReferences(observed);
  await validateLiveRoutes();

  console.log(`[downloads] release: ${observed.release.tag_name} (${observed.release.html_url})`);
  console.log(`[downloads] android: ${observed.apk.size} bytes ${observed.apk.digest}`);
  console.log(`[downloads] windows: ${observed.exe.size} bytes ${observed.exe.digest}`);
  console.log('[downloads] repository references, provenance, production routes, and direct download routes: OK');
}

main().catch((error) => {
  console.error(`[downloads] FAIL: ${error?.stack || error}`);
  process.exitCode = 1;
});

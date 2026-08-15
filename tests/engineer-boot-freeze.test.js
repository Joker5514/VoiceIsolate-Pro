/**
 * Engineer Mode cold-open freeze guards (structural).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const consoleJs = fs.readFileSync(path.join(ROOT, 'public/app/engineer-console.js'), 'utf8');
const bootJs = fs.readFileSync(path.join(ROOT, 'public/app/vip-boot.js'), 'utf8');

describe('Engineer boot freeze guards', () => {
  test('init yields slider render and awaits it', () => {
    expect(appJs).toMatch(/await this\._renderSliders\(\)/);
    expect(appJs).toMatch(/async _renderSliders/);
    expect(appJs).toMatch(/yieldToBrowser/);
  });

  test('ML warmup is not fire-and-forget on init (mobile skip / idle desktop)', () => {
    const initBlock = appJs.slice(
      appJs.indexOf('async init()'),
      appJs.indexOf('window.__vipAppReady'),
    );
    expect(initBlock).toMatch(/ML warmup deferred until Process on mobile/);
    expect(initBlock).toMatch(/requestIdleCallback/);
    // Must not call warmup before idle scheduling on the critical path
    expect(initBlock).toMatch(/scheduleIdle\(\(\)\s*=>\s*\{[\s\S]*_warmupMLModels/);
  });

  test('engineer-console defers integrity ticker and prefers simple view on mobile', () => {
    expect(consoleJs).toMatch(/ec-simple/);
    expect(consoleJs).toMatch(/requestIdleCallback/);
    expect(consoleJs).toMatch(/2800/);
  });

  test('vip-boot pill poll is slower on mobile', () => {
    expect(bootJs).toMatch(/mobileShell \? 1000 : 250/);
  });
});

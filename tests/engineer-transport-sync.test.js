const fs = require('fs');
const path = require('path');
const getAppCode = require('./helpers/get-app-code');

const APP_JS = getAppCode();
const VIP_FIXES = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'vip-fixes.js'), 'utf8');
const VISUALS_BOOT = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'visuals-bootstrap.js'), 'utf8');

let VoiceIsolatePro;
try {
  const safeCode = APP_JS.replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/, '');
  VoiceIsolatePro = new Function('window', 'document', safeCode + '; return VoiceIsolatePro;')({}, {});
} catch (e) {
  throw new Error('Failed to load VoiceIsolatePro: ' + e.message);
}

describe('Engineer Mode transport sync', () => {
  test('app.js uses bridge clock whenever _transportViaBridge is set', () => {
    expect(APP_JS).toContain('_transportViaBridge');
    expect(APP_JS).toMatch(/_transportViaBridge[\s\S]*bridge\.currentTime/);
    expect(APP_JS).not.toMatch(
      /_getTransportPosition\(\)[\s\S]*bridge\?\.isPlaying\?\.\(\)[\s\S]*return bridge\.currentTime/,
    );
  });

  test('app.js dispatches vip:transportTick from the transport clock', () => {
    expect(APP_JS).toContain("'vip:transportTick'");
    expect(APP_JS).toMatch(/_startTransportClock[\s\S]*vip:transportTick/);
  });

  test('vip-fixes sets _transportViaBridge on bridge play and clears on fallback', () => {
    expect(VIP_FIXES).toContain('app._transportViaBridge = true');
    expect(VIP_FIXES).toContain('app._transportViaBridge = false');
    expect(VIP_FIXES).toMatch(/_elapsedSeconds[\s\S]*app\._getTransportPosition/);
  });

  test('visuals-bootstrap reads transport from app._getTransportPosition and paints on transport tick', () => {
    expect(VISUALS_BOOT).toMatch(/_getPlayOffset[\s\S]*app\._getTransportPosition/);
    expect(VISUALS_BOOT).toContain("'vip:transportTick'");
    expect(VISUALS_BOOT).toContain('paintPlayheads');
  });

  describe('_getTransportPosition()', () => {
    let ctx;

    beforeEach(() => {
      ctx = {
        abMode: 'original',
        isPlaying: false,
        playOffset: 12,
        playStartTime: 100,
        _transportViaBridge: true,
        ctx: { currentTime: 250 },
        dom: { tpSpeed: { value: 1 } },
        _bridge: {
          isPlaying: () => false,
          currentTime: () => 45,
        },
      };
    });

    it('returns bridge.currentTime during seek gap (app playing, mixer idle)', () => {
      ctx.isPlaying = true;
      expect(VoiceIsolatePro.prototype._getTransportPosition.call(ctx)).toBe(45);
    });

    it('returns bridge.currentTime while mixer is playing', () => {
      ctx._bridge.isPlaying = () => true;
      ctx._bridge.currentTime = () => 67.5;
      ctx.isPlaying = true;
      expect(VoiceIsolatePro.prototype._getTransportPosition.call(ctx)).toBe(67.5);
    });

    it('does not use stale wall-clock math when bridge drives transport', () => {
      ctx.isPlaying = true;
      ctx.playOffset = 12;
      ctx.playStartTime = 100;
      ctx.ctx.currentTime = 500;
      expect(VoiceIsolatePro.prototype._getTransportPosition.call(ctx)).toBe(45);
    });

    it('falls back to wall-clock math when not on bridge transport', () => {
      ctx._transportViaBridge = false;
      ctx.isPlaying = true;
      ctx.playOffset = 10;
      ctx.playStartTime = 100;
      ctx.ctx.currentTime = 110;
      expect(VoiceIsolatePro.prototype._getTransportPosition.call(ctx)).toBe(20);
    });

    it('returns playOffset when paused off-bridge', () => {
      ctx._transportViaBridge = false;
      ctx.isPlaying = false;
      ctx.playOffset = 33;
      expect(VoiceIsolatePro.prototype._getTransportPosition.call(ctx)).toBe(33);
    });
  });
});
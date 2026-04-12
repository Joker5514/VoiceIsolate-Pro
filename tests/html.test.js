/**
 * VoiceIsolate Pro — HTML Structure & Accessibility Tests
 * Verifies the pipeline progress bar has correct ARIA attributes across all HTML files.
 */

const fs = require('fs');
const path = require('path');

const htmlFiles = [
  { label: 'index.html (root)', filePath: path.join(__dirname, '../index.html') },
  { label: 'build/app/index.html', filePath: path.join(__dirname, '../build/app/index.html') },
  { label: 'public/app/index.html', filePath: path.join(__dirname, '../public/app/index.html') },
];

describe('Pipeline progress bar accessibility', () => {
  htmlFiles.forEach(({ label, filePath }) => {
    describe(label, () => {
      let html;

      beforeAll(() => {
        html = fs.readFileSync(filePath, 'utf8');
      });

      test('pipeBar element has id="pipeBar"', () => {
        expect(html).toContain('id="pipeBar"');
      });

      test('pipeBar element has role="progressbar"', () => {
        expect(html).toContain('role="progressbar"');
      });

      test('pipeBar element has aria-valuemin="0"', () => {
        expect(html).toContain('aria-valuemin="0"');
      });

      test('pipeBar element has aria-valuemax="100"', () => {
        expect(html).toContain('aria-valuemax="100"');
      });

      test('pipeBar element has aria-valuenow="0" as initial state', () => {
        expect(html).toContain('aria-valuenow="0"');
      });

      test('pipeBar element has aria-label="Processing progress"', () => {
        expect(html).toContain('aria-label="Processing progress"');
      });

      test('pipeBar ARIA attributes are on the same element as the pipe-bar class', () => {
        // All attributes must appear together on the .pipe-bar container, not scattered
        expect(html).toMatch(
          /class="pipe-bar"[^>]*id="pipeBar"|id="pipeBar"[^>]*class="pipe-bar"/
        );
      });

      test('pipeFill child element is still present inside pipeBar', () => {
        // The inner fill element must not have been removed when adding ARIA attrs
        expect(html).toContain('id="pipeFill"');
        expect(html).toContain('class="pipe-fill"');
      });
    });
  });
});

describe('Pipeline progress bar — structure integrity', () => {
  test('all three HTML files contain identical pipeBar markup', () => {
    const contents = htmlFiles.map(({ filePath }) => fs.readFileSync(filePath, 'utf8'));

    // Extract the pipe-bar line from each file for comparison
    const extractPipeBarLine = (html) => {
      const match = html.match(/<div[^>]+pipe-bar[^>]*>/);
      return match ? match[0] : null;
    };

    const [root, build, pub] = contents.map(extractPipeBarLine);
    expect(root).not.toBeNull();
    expect(root).toEqual(build);
    expect(root).toEqual(pub);
  });

  test('pipeBar does not have role="progressbar" on the inner pipeFill element', () => {
    htmlFiles.forEach(({ filePath }) => {
      const html = fs.readFileSync(filePath, 'utf8');
      // The pipeFill div should not carry the progressbar role
      expect(html).not.toMatch(/id="pipeFill"[^>]*role="progressbar"/);
    });
  });

  test('aria-valuemin is less than aria-valuemax (valid range)', () => {
    htmlFiles.forEach(({ filePath }) => {
      const html = fs.readFileSync(filePath, 'utf8');
      const minMatch = html.match(/aria-valuemin="(\d+)"/);
      const maxMatch = html.match(/aria-valuemax="(\d+)"/);
      expect(minMatch).not.toBeNull();
      expect(maxMatch).not.toBeNull();
      expect(Number(minMatch[1])).toBeLessThan(Number(maxMatch[1]));
    });
  });

  test('aria-valuenow is within the declared min/max range', () => {
    htmlFiles.forEach(({ filePath }) => {
      const html = fs.readFileSync(filePath, 'utf8');
      const minMatch = html.match(/aria-valuemin="(\d+)"/);
      const maxMatch = html.match(/aria-valuemax="(\d+)"/);
      const nowMatch = html.match(/aria-valuenow="(\d+)"/);
      expect(nowMatch).not.toBeNull();
      const min = Number(minMatch[1]);
      const max = Number(maxMatch[1]);
      const now = Number(nowMatch[1]);
      expect(now).toBeGreaterThanOrEqual(min);
      expect(now).toBeLessThanOrEqual(max);
    });
  });
});

// ── _vipSafetyNet inline script — HTML structure ─────────────────────────────

const publicAppHtmlPath = path.join(__dirname, '../public/app/index.html');

describe('public/app/index.html — _vipSafetyNet script presence', () => {
  let html;

  beforeAll(() => {
    html = fs.readFileSync(publicAppHtmlPath, 'utf8');
  });

  test('contains the _vipSafetyNet inline script block', () => {
    expect(html).toContain('_vipSafetyNet');
  });

  test('safety-net script appears after vip-boot.js script tag', () => {
    const vipBootPos  = html.indexOf('vip-boot.js');
    const safetyNetPos = html.indexOf('_vipSafetyNet');
    expect(vipBootPos).toBeGreaterThan(-1);
    expect(safetyNetPos).toBeGreaterThan(vipBootPos);
  });

  test('safety-net script instantiates VoiceIsolatePro when _vipApp is absent', () => {
    expect(html).toContain('!window._vipApp && typeof VoiceIsolatePro');
  });

  test('safety-net script sets _initCalled = true on the new instance', () => {
    expect(html).toContain('app._initCalled = true');
  });

  test('safety-net script assigns both window.vip and window._vipApp', () => {
    expect(html).toContain('window.vip');
    expect(html).toContain('window._vipApp = app');
  });

  test('safety-net script guards Auth.init() with isLoggedIn and currentUser checks', () => {
    expect(html).toContain('!Auth.isLoggedIn && Auth.currentUser === null');
  });

  test('safety-net script uses { once: true } on DOMContentLoaded listener', () => {
    expect(html).toContain('{ once: true }');
  });

  test('safety-net script checks document.readyState before registering DOMContentLoaded', () => {
    expect(html).toMatch(/document\.readyState.*['"]loading['"]/);
  });
});

// ── _vipSafetyNet — behavioural tests ────────────────────────────────────────

/**
 * Extract the inline safety-net script body from index.html and return it
 * as a string that can be evaluated in a controlled environment.
 */
function extractSafetyNetSrc() {
  const html = fs.readFileSync(publicAppHtmlPath, 'utf8');
  // Grab everything inside the <script> tag that contains _vipSafetyNet
  const match = html.match(/<script>\s*([\s\S]*?_vipSafetyNet[\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not extract _vipSafetyNet script from index.html');
  return match[1];
}

const safetyNetSrc = extractSafetyNetSrc();

function makeDocument(readyState = 'complete') {
  const listeners = {};
  return {
    readyState,
    addEventListener: jest.fn((event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    removeEventListener: jest.fn(),
    _triggerEvent(event) {
      (listeners[event] || []).forEach(cb => cb());
    },
  };
}

function makeConsole() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() };
}

function makeAuth(overrides = {}) {
  return Object.assign(
    { init: jest.fn().mockResolvedValue(undefined), isLoggedIn: false, currentUser: null },
    overrides
  );
}

function runSafetyNet({ readyState = 'complete', windowExtras = {}, VoiceIsolatePro, Auth } = {}) {
  const doc = makeDocument(readyState);
  const con = makeConsole();
  const win = Object.assign({ _vipApp: undefined, vip: undefined }, windowExtras);

  const fn = new Function(
    'window', 'document', 'VoiceIsolatePro', 'Auth', 'console',
    safetyNetSrc
  );
  fn(win, doc, VoiceIsolatePro, Auth, con);
  return { win, doc, con };
}

describe('public/app/index.html — _vipSafetyNet behaviour (DOM ready)', () => {
  test('instantiates VoiceIsolatePro when window._vipApp is absent', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { win } = runSafetyNet({ VoiceIsolatePro: VIP });
    expect(VIP).toHaveBeenCalledTimes(1);
    expect(win._vipApp).toBeInstanceOf(VIP);
    expect(win.vip).toBe(win._vipApp);
  });

  test('sets _initCalled = true on the newly created instance', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { win } = runSafetyNet({ VoiceIsolatePro: VIP });
    expect(win._vipApp._initCalled).toBe(true);
  });

  test('skips instantiation when window._vipApp is already set', () => {
    const existing = { _initCalled: true };
    const VIP = jest.fn();
    const { win } = runSafetyNet({ VoiceIsolatePro: VIP, windowExtras: { _vipApp: existing } });
    expect(VIP).not.toHaveBeenCalled();
    expect(win._vipApp).toBe(existing);
  });

  test('calls Auth.init() when Auth defined, not logged in, currentUser null', () => {
    const VIP  = jest.fn().mockImplementation(function () {});
    const auth = makeAuth({ isLoggedIn: false, currentUser: null });
    runSafetyNet({ VoiceIsolatePro: VIP, Auth: auth });
    expect(auth.init).toHaveBeenCalledTimes(1);
  });

  test('skips Auth.init() when Auth.isLoggedIn is truthy', () => {
    const VIP  = jest.fn().mockImplementation(function () {});
    const auth = makeAuth({ isLoggedIn: true, currentUser: null });
    runSafetyNet({ VoiceIsolatePro: VIP, Auth: auth });
    expect(auth.init).not.toHaveBeenCalled();
  });

  test('skips Auth.init() when Auth.currentUser is not null', () => {
    const VIP  = jest.fn().mockImplementation(function () {});
    const auth = makeAuth({ isLoggedIn: false, currentUser: { uid: 'x' } });
    runSafetyNet({ VoiceIsolatePro: VIP, Auth: auth });
    expect(auth.init).not.toHaveBeenCalled();
  });

  test('does not throw when VoiceIsolatePro is undefined', () => {
    expect(() => runSafetyNet({ VoiceIsolatePro: undefined })).not.toThrow();
  });

  test('does not throw when Auth is undefined', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    expect(() => runSafetyNet({ VoiceIsolatePro: VIP, Auth: undefined })).not.toThrow();
  });

  test('catches and warns when VoiceIsolatePro constructor throws', () => {
    const VIP = jest.fn().mockImplementation(() => { throw new Error('ctor err'); });
    const { con, win } = runSafetyNet({ VoiceIsolatePro: VIP });
    expect(con.warn).toHaveBeenCalledWith(
      expect.stringContaining('[safety-net] instantiation failed:'),
      expect.any(Error)
    );
    expect(win._vipApp).toBeUndefined();
  });

  test('still calls Auth.init() even when VoiceIsolatePro is already instantiated', () => {
    const existing = { _initCalled: true };
    const VIP  = jest.fn();
    const auth = makeAuth({ isLoggedIn: false, currentUser: null });
    runSafetyNet({ VoiceIsolatePro: VIP, Auth: auth, windowExtras: { _vipApp: existing } });
    // VoiceIsolatePro not called but Auth.init still should be
    expect(VIP).not.toHaveBeenCalled();
    expect(auth.init).toHaveBeenCalledTimes(1);
  });
});

describe('public/app/index.html — _vipSafetyNet behaviour (DOM loading)', () => {
  test('registers DOMContentLoaded listener when readyState is "loading"', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { doc } = runSafetyNet({ readyState: 'loading', VoiceIsolatePro: VIP });
    expect(VIP).not.toHaveBeenCalled();
    expect(doc.addEventListener).toHaveBeenCalledWith(
      'DOMContentLoaded', expect.any(Function), { once: true }
    );
  });

  test('defers instantiation until DOMContentLoaded fires', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { win, doc } = runSafetyNet({ readyState: 'loading', VoiceIsolatePro: VIP });
    expect(VIP).not.toHaveBeenCalled();
    doc._triggerEvent('DOMContentLoaded');
    expect(VIP).toHaveBeenCalledTimes(1);
    expect(win._vipApp).toBeInstanceOf(VIP);
  });

  test('calls Auth.init() in deferred path when conditions are met', async () => {
    const VIP  = jest.fn().mockImplementation(function () {});
    const auth = makeAuth({ isLoggedIn: false, currentUser: null });
    const { doc } = runSafetyNet({ readyState: 'loading', VoiceIsolatePro: VIP, Auth: auth });
    doc._triggerEvent('DOMContentLoaded');
    expect(auth.init).toHaveBeenCalledTimes(1);
  });
});
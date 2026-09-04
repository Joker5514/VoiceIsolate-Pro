/**
 * Service-worker activation and registration lifecycle regressions.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const swSource = fs.readFileSync(path.join(ROOT, 'public', 'app', 'sw.js'), 'utf8');
const registerSource = fs.readFileSync(path.join(ROOT, 'public', 'app', 'sw-register.js'), 'utf8');

describe('service-worker lifecycle', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function createRegistrationHarness() {
    let controllerChange = null;
    const serviceWorker = {
      controller: null,
      register: jest.fn().mockResolvedValue({ scope: '/' }),
      addEventListener: jest.fn((type, listener) => {
        if (type === 'controllerchange') controllerChange = listener;
      }),
      removeEventListener: jest.fn((type, listener) => {
        if (type === 'controllerchange' && controllerChange === listener) controllerChange = null;
      }),
      getRegistrations: jest.fn().mockResolvedValue([]),
    };
    const context = {
      console,
      navigator: { userAgent: 'Desktop Chrome', serviceWorker },
      fetch: jest.fn().mockResolvedValue({ ok: false }),
      setTimeout,
      clearTimeout,
      window: {},
      globalThis: null,
    };
    context.globalThis = context;
    const executable = registerSource
      .replace(/\bexport\s+/g, '')
      .concat('\nglobalThis.__registerSW = registerSW;');
    vm.runInNewContext(executable, context, { filename: 'sw-register.js' });
    return {
      registerSW: context.__registerSW,
      serviceWorker,
      fireControllerChange: () => controllerChange?.(),
    };
  }

  async function flushRegistrationSetup() {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  test('does not force a waiting update over an active processing tab', () => {
    expect(swSource).not.toMatch(/skipWaiting\s*\(/);
    expect(swSource).toMatch(/normal waiting lifecycle/);
  });

  test('controllerchange clears its safety timer and listener', async () => {
    jest.useFakeTimers();
    const { registerSW, serviceWorker, fireControllerChange } = createRegistrationHarness();
    const pending = registerSW();
    await flushRegistrationSetup();
    expect(serviceWorker.addEventListener).toHaveBeenCalledWith('controllerchange', expect.any(Function));

    fireControllerChange();
    await expect(pending).resolves.toEqual({ scope: '/' });

    expect(serviceWorker.removeEventListener)
      .toHaveBeenCalledWith('controllerchange', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
  });

  test('registration timeout removes its controllerchange listener', async () => {
    jest.useFakeTimers();
    const { registerSW, serviceWorker } = createRegistrationHarness();
    const pending = registerSW();
    await flushRegistrationSetup();
    expect(serviceWorker.addEventListener).toHaveBeenCalledWith('controllerchange', expect.any(Function));

    await jest.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toEqual({ scope: '/' });

    expect(serviceWorker.removeEventListener)
      .toHaveBeenCalledWith('controllerchange', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
  });

  test('pill polling has duplicate-start and pagehide cleanup', () => {
    const bootSource = fs.readFileSync(path.join(ROOT, 'public', 'app', 'vip-boot.js'), 'utf8');
    expect(bootSource).toMatch(/_vipPillDriverCleanup/);
    expect(bootSource).toMatch(/pagehide[\s\S]*stopPillDriver/);
    expect(bootSource).toMatch(/MAX_DRIVER_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
  });

  test('registration source uses one settle path for event and timeout', () => {
    expect(registerSource).toMatch(/const finish = \(\) =>/);
    expect(registerSource).toMatch(/clearTimeout\(timer\)/);
  });
});

/**
 * Processing overlay ownership and animation lifecycle regressions.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'app', 'processing-overlay.js'),
  'utf8',
);

function loadOverlay(originalRun, vipOverrides = {}) {
  let sequence = 0;
  let currentJobId = null;
  const jobs = {
    beginJob: jest.fn(() => {
      currentJobId = `job-${++sequence}`;
      return { id: currentJobId };
    }),
    endJob: jest.fn((jobId) => {
      if (jobId !== currentJobId) return false;
      currentJobId = null;
      return true;
    }),
    getCurrentJobId: jest.fn(() => currentJobId),
    isCancellationError: jest.fn(() => false),
    cancelCurrent: jest.fn(() => { currentJobId = null; }),
  };
  const overlay = {
    show: jest.fn(),
    hide: jest.fn(),
    update: jest.fn(),
    _el: jest.fn(() => null),
  };
  const vip = {
    runPipeline: originalRun,
    pip: null,
    showNotification: jest.fn(),
    abortFlag: false,
    ...vipOverrides,
  };
  const document = {
    readyState: 'loading',
    addEventListener: jest.fn(),
    getElementById: jest.fn(() => null),
  };
  const context = {
    console,
    document,
    VIPOverlay: overlay,
    __VIP_JOBS__: jobs,
    vip,
    window: null,
    globalThis: null,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    CustomEvent: class CustomEvent {},
  };
  context.window = context;
  context.globalThis = context;
  const instrumented = SOURCE.replace(
    '  patchOverlayWhenReady();',
    '  global.__VIP_OVERLAY_TEST__ = { Overlay: Overlay };\n  patchOverlayWhenReady();',
  );
  vm.runInNewContext(instrumented, context, { filename: 'processing-overlay.js' });
  return { context, vip, jobs, overlay, getCurrentJobId: () => currentJobId };
}

describe('processing overlay lifecycle', () => {
  test('a superseded run cannot clear or hide the newer run', async () => {
    const resolvers = [];
    const { vip, overlay } = loadOverlay(jest.fn(() => new Promise((resolve) => {
      resolvers.push(resolve);
    })));

    const first = vip.runPipeline();
    const firstJobId = vip._activeJobId;
    const second = vip.runPipeline();
    const secondJobId = vip._activeJobId;
    expect(secondJobId).not.toBe(firstJobId);

    resolvers[0]('first');
    await expect(first).resolves.toBe('first');
    expect(vip._activeJobId).toBe(secondJobId);
    expect(overlay.hide).not.toHaveBeenCalled();

    resolvers[1]('second');
    await expect(second).resolves.toBe('second');
    expect(vip._activeJobId).toBeNull();
    expect(overlay.hide).toHaveBeenCalledTimes(1);
  });

  test('ending a stale global job leaves the current overlay visible', () => {
    const { vip, overlay } = loadOverlay(jest.fn().mockResolvedValue(undefined));
    const first = vip.beginGlobalJob('first');
    const second = vip.beginGlobalJob('second');

    expect(vip.endGlobalJob(first.id, 'completed')).toBe(false);
    expect(vip._activeJobId).toBe(second.id);
    expect(overlay.hide).not.toHaveBeenCalled();

    expect(vip.endGlobalJob(second.id, 'completed')).toBe(true);
    expect(overlay.hide).toHaveBeenCalledTimes(1);
  });

  test('hide stops both animation loops and init restarts existing instances', () => {
    const { context } = loadOverlay(jest.fn().mockResolvedValue(undefined));
    const controller = context.__VIP_OVERLAY_TEST__.Overlay;
    const spinner = { start: jest.fn(), stop: jest.fn() };
    const spectro = { start: jest.fn(), stop: jest.fn() };
    controller._spinner = spinner;
    controller._spectro = spectro;
    controller._el = () => ({
      classList: { remove: jest.fn() },
      setAttribute: jest.fn(),
    });
    controller._setBusyControls = jest.fn();
    controller._stopMessages = jest.fn();
    context.document.body = { classList: { remove: jest.fn() } };

    controller.hide({ restoreFocus: false });
    controller._initCanvases();

    expect(spinner.stop).toHaveBeenCalledTimes(1);
    expect(spectro.stop).toHaveBeenCalledTimes(1);
    expect(spinner.start).toHaveBeenCalledTimes(1);
    expect(spectro.start).toHaveBeenCalledTimes(1);
  });

  test('overlay progress is clamped and monotonic within one show cycle', () => {
    expect(SOURCE).toMatch(/nextPct[\s\S]*Math\.max\(this\._lastProgress, nextPct\)/);
    expect(SOURCE).toMatch(/this\._lastProgress = 0;[\s\S]*this\.update/);
  });

  test('preserves the app worker-cancellation implementation', () => {
    const originalCancel = jest.fn().mockReturnValue('cancelled');
    const { vip, jobs } = loadOverlay(
      jest.fn().mockResolvedValue(undefined),
      { cancelActiveJobs: originalCancel },
    );

    expect(vip.cancelActiveJobs()).toBe('cancelled');
    expect(originalCancel).toHaveBeenCalledTimes(1);
    expect(jobs.cancelCurrent).not.toHaveBeenCalled();
  });
});

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
  test('a duplicate pipeline request cannot supersede the active run', async () => {
    const resolvers = [];
    const { vip, overlay } = loadOverlay(jest.fn(() => new Promise((resolve) => {
      resolvers.push(resolve);
    })));

    const first = vip.runPipeline();
    const firstJobId = vip._activeJobId;
    const second = vip.runPipeline();
    await expect(second).resolves.toBeUndefined();
    expect(vip._activeJobId).toBe(firstJobId);
    expect(resolvers).toHaveLength(1);
    expect(overlay.show).toHaveBeenCalledTimes(1);

    resolvers[0]('done');
    await expect(first).resolves.toBe('done');
    expect(vip._activeJobId).toBeNull();
    expect(overlay.hide).toHaveBeenCalledTimes(1);
  });

  test('stale job progress and hide calls cannot mutate a newer overlay', () => {
    const { vip, overlay } = loadOverlay(jest.fn().mockResolvedValue(undefined));
    const first = vip.beginGlobalJob('first');
    const second = vip.beginGlobalJob('second');
    const updateCount = overlay.update.mock.calls.length;

    expect(vip.updateProcessingOverlay('stale', 90, 28, first.id)).toBe(false);
    expect(vip.hideProcessingOverlay(first.id)).toBe(false);
    expect(overlay.update).toHaveBeenCalledTimes(updateCount);
    expect(overlay.hide).not.toHaveBeenCalled();

    expect(vip.updateProcessingOverlay('current', 50, 16, second.id)).toBe(true);
    expect(overlay.update).toHaveBeenLastCalledWith('current', 50, 16);
  });

  test('ownerless cleanup hides an orphaned overlay only after the current job clears', () => {
    const { vip, jobs, overlay } = loadOverlay(jest.fn().mockResolvedValue(undefined));
    vip.beginGlobalJob('pipeline');

    expect(vip.hideProcessingOverlay()).toBe(false);
    expect(overlay.hide).not.toHaveBeenCalled();

    jobs.cancelCurrent('forced cleanup');
    expect(vip.hideProcessingOverlay()).toBe(true);
    expect(overlay.hide).toHaveBeenCalledTimes(1);
  });

  test('a superseded pipeline releases its run guard without hiding the successor', async () => {
    let finishPipeline;
    const { vip, overlay } = loadOverlay(jest.fn(() => new Promise((resolve) => {
      finishPipeline = resolve;
    })));
    const pipeline = vip.runPipeline();
    const successor = vip.beginGlobalJob('analysis', { kind: 'analysis' });

    finishPipeline('cancelled');
    await expect(pipeline).resolves.toBe('cancelled');

    expect(vip._pipelineRunPending).toBe(false);
    expect(vip._activeJobId).toBe(successor.id);
    expect(overlay.hide).not.toHaveBeenCalled();
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
    const { context } = loadOverlay(jest.fn().mockResolvedValue(undefined));
    const controller = context.__VIP_OVERLAY_TEST__.Overlay;
    const bar = { style: {} };
    const pct = { textContent: '' };
    const element = {
      classList: { add: jest.fn(), remove: jest.fn() },
      setAttribute: jest.fn(),
      querySelector: jest.fn(() => null),
    };
    context.document.activeElement = null;
    context.document.body = { classList: { add: jest.fn(), remove: jest.fn() } };
    controller._el = () => element;
    controller._bar = () => bar;
    controller._pct = () => pct;
    controller._stageName = () => null;
    controller._stageIndex = () => null;
    controller._focus = () => null;
    controller._mode = () => null;
    controller._stageChip = () => null;
    controller._phasePills = () => [];
    controller._setBusyControls = jest.fn();
    controller._initCanvases = jest.fn();
    controller._startMessages = jest.fn();
    controller._wireCancel = jest.fn();
    controller._refreshOrtPill = jest.fn();
    controller._tickElapsed = jest.fn();
    controller._announce = jest.fn();

    controller.show('first', 40);
    controller.update('too low', 20, 2);
    expect(bar.style.width).toBe('40%');
    controller.update('too high', 140, 3);
    expect(bar.style.width).toBe('100%');
    controller.show('new cycle', 5);
    expect(bar.style.width).toBe('5%');
    controller.hide({ restoreFocus: false });
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

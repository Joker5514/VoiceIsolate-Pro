/**
 * Model status pills must say when an advanced model did not run.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/app/model-status-ui.js'), 'utf8')
  .replace('export class ModelStatusUI', 'class ModelStatusUI');

function createElement(tag) {
  return {
    tag,
    className: '',
    textContent: '',
    title: '',
    dataset: {},
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    classList: { add() {}, remove() {} },
  };
}

function bootUI(keys) {
  const sandbox = {
    console,
    BroadcastChannel,
    document: { createElement },
    window: {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async () => ({ ok: false }),
    caches: { open: async () => ({ match: async () => null }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC + '\nthis.ModelStatusUI = ModelStatusUI;', sandbox);
  const container = createElement('div');
  const ui = new sandbox.ModelStatusUI(container, keys);
  return { ui, container };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('ModelStatusUI fallback dispositions', () => {
  test('fallback, unavailable, and unsupported pills do not claim the model ran', async () => {
    const { ui } = bootUI(['ecapa_tdnn', 'demucs', 'bsrnn_complex']);
    const channel = new BroadcastChannel('vip-model-progress');
    channel.postMessage({
      type: 'fallback',
      model: 'ecapa_tdnn',
      using: '24-D mel voiceprint',
      reason: 'ECAPA-TDNN unavailable',
    });
    channel.postMessage({
      type: 'unavailable',
      model: 'demucs',
      reason: 'HTTP 404',
    });
    channel.postMessage({
      type: 'unsupported',
      model: 'bsrnn_complex',
      reason: 'no checksum',
    });
    await flush();

    const ecapa = ui._pills.ecapa_tdnn;
    const demucs = ui._pills.demucs;
    const complex = ui._pills.bsrnn_complex;
    expect(ecapa.textContent).toMatch(/did not run/i);
    expect(ecapa.textContent).toMatch(/24-D mel voiceprint/);
    expect(ecapa.textContent).not.toMatch(/loaded|cached|shipped/i);
    expect(ecapa.title).toMatch(/did not run/i);
    expect(ecapa.title).toMatch(/ECAPA-TDNN unavailable/);
    expect(demucs.textContent).toMatch(/Unavailable/);
    expect(demucs.textContent).not.toMatch(/did not run — fallback/);
    expect(demucs.title).toMatch(/did not run/);
    expect(complex.textContent).toMatch(/Unsupported/);
    expect(complex.title).toMatch(/no checksum/);
    expect(ui._runtimeStatus.get('demucs').status).toBe('unavailable');
    channel.close();
    ui.destroy();
  });

  test('refresh does not replace a fallback disposition with optional-not-shipped', async () => {
    const { ui } = bootUI(['demucs']);
    ui.setStatus('demucs', 'fallback', undefined, undefined, {
      using: 'classical DSP',
      title: 'demucs did not run. Fallback active: classical DSP.',
    });
    ui._pills.demucs.textContent = '';
    await ui.refreshStatus();
    expect(ui._pills.demucs.textContent).toMatch(/did not run/);
    expect(ui._pills.demucs.textContent).not.toMatch(/Optional — not shipped/);
    ui.destroy();
  });
});

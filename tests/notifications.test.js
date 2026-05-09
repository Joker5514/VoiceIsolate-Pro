const fs = require('fs');
const path = require('path');
const vm = require('vm');
const getAppCode = require('./helpers/get-app-code');

// We load app.js inside a vm sandbox so the `document` and `window` references
// inside the source resolve to mocks we control per-test. Mirrors the loader
// pattern in tests/handle_file_decode.test.js.
function buildElementShim() {
  return {
    id: '',
    className: '',
    type: '',
    textContent: '',
    children: [],
    attrs: {},
    listeners: {},
    parentNode: null,
    get firstChild() { return this.children[0] || null; },
    classList: (() => {
      const set = new Set();
      return {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        contains: (c) => set.has(c),
        toggle: (c) => { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; },
      };
    })(),
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    addEventListener(name, fn) { this.listeners[name] = fn; },
  };
}

describe('showNotification / _showToast', () => {
  let VoiceIsolatePro;
  let mockDocument;
  let region;

  beforeEach(() => {
    const body = buildElementShim();
    region = buildElementShim();
    region.id = 'toastRegion';
    body.appendChild(region);
    mockDocument = {
      body,
      getElementById: (id) => (id === 'toastRegion' ? region : null),
      createElement: () => buildElementShim(),
      addEventListener: () => {},
    };

    const sandbox = {
      document: mockDocument,
      window: {},
      module: { exports: {} },
      Float32Array,
      Math,
      console: { error: () => {}, warn: () => {}, log: () => {}, debug: () => {}, info: () => {} },
      parseFloat,
      URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
      setTimeout,
      clearTimeout,
      Promise,
      requestAnimationFrame: (cb) => { cb(); return 1; },
    };
    vm.createContext(sandbox);
    const appJs = getAppCode();
    vm.runInContext(appJs, sandbox);
    VoiceIsolatePro = sandbox.module.exports;
  });

  it('appends a toast element to the toastRegion', () => {
    const inst = Object.create(VoiceIsolatePro.prototype);
    inst.showNotification('Hello world', 'info', 0);
    expect(region.children.length).toBe(1);
    const toast = region.children[0];
    expect(toast.className).toContain('toast');
    expect(toast.className).toContain('toast-info');
    // Message text node is the first child.
    expect(toast.children[0].textContent).toBe('Hello world');
  });

  it('uses role=alert for error toasts so screen readers interrupt', () => {
    const inst = Object.create(VoiceIsolatePro.prototype);
    inst.showNotification('Decode failed', 'error', 0);
    expect(region.children.length).toBe(1);
    const toast = region.children[0];
    expect(toast.getAttribute('role')).toBe('alert');
    expect(toast.className).toContain('toast-error');
  });

  it('caps stacked toasts at 4', () => {
    const inst = Object.create(VoiceIsolatePro.prototype);
    for (let i = 0; i < 6; i++) inst.showNotification('msg ' + i, 'info', 0);
    expect(region.children.length).toBeLessThanOrEqual(4);
  });

  it('_showToast is an alias for showNotification', () => {
    const inst = Object.create(VoiceIsolatePro.prototype);
    expect(typeof inst._showToast).toBe('function');
    inst._showToast('Aliased', 'warn', 0);
    expect(region.children.length).toBe(1);
    const toast = region.children[0];
    expect(toast.className).toContain('toast-warn');
  });

  it('returns a dismiss function that removes the toast', async () => {
    const inst = Object.create(VoiceIsolatePro.prototype);
    const dismiss = inst.showNotification('Bye', 'info', 0);
    expect(typeof dismiss).toBe('function');
    expect(region.children.length).toBe(1);
    dismiss();
    // Removal is queued via real setTimeout(220) — wait it out.
    await new Promise(r => setTimeout(r, 260));
    expect(region.children.length).toBe(0);
  });
});

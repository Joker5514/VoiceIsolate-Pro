/**
 * @jest-environment jsdom
 *
 * OnDeviceBadge owns its label node. If that node never mounts, setStatus
 * must not throw the textContent TypeError that landing reports as an upload.
 */

'use strict';

/* global document -- provided by the jsdom test environment */

let OnDeviceBadge;

beforeAll(async () => {
  ({ OnDeviceBadge } = await import('../src/ui/components/OnDeviceBadge/OnDeviceBadge.js'));
});

describe('OnDeviceBadge.setStatus', () => {
  test('updates the label when the badge mounted', () => {
    const host = document.createElement('span');
    const badge = new OnDeviceBadge(host, { backend: 'WASM' });
    badge.setStatus('processing', 'WASM');
    expect(host.querySelector('[data-label]').textContent).toBe('Processing locally');
    expect(host.querySelector('[data-backend]').textContent).toBe('WASM');
  });

  test('warns and returns when the status nodes never mounted', () => {
    const host = document.createElement('span');
    host.querySelector = () => null;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const badge = new OnDeviceBadge(host, { backend: 'WASM' });
    expect(badge._els.label).toBeNull();
    expect(() => badge.setStatus('ready', 'WASM')).not.toThrow();
    expect(() => badge.setBackend('WebGPU')).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a cleared container does not make a later setStatus throw', () => {
    const host = document.createElement('span');
    const badge = new OnDeviceBadge(host);
    badge.dispose();
    badge._els.label = null;
    badge._els.dot = null;
    badge._els.backend = null;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => badge.setStatus('processing')).not.toThrow();
    expect(warn.mock.calls.some((call) => String(call[0]).includes('status nodes missing'))).toBe(true);
    warn.mockRestore();
  });
});

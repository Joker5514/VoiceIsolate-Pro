/**
 * VoiceIsolate Pro — DesktopBridge unit tests
 */
'use strict';

import { jest } from '@jest/globals';
import {
  isDesktopShell,
  pickAudioFile,
  saveExportBlob,
  filtersForFilename,
} from '../src/core/DesktopBridge.js';

import { pickAndIngestFile } from '../src/pipeline/FileIngestion.js';

describe('DesktopBridge', () => {
  const originalVip = globalThis.vipDesktop;

  afterEach(() => {
    if (originalVip === undefined) {
      delete globalThis.vipDesktop;
    } else {
      globalThis.vipDesktop = originalVip;
    }
  });

  test('isDesktopShell false without vipDesktop', () => {
    delete globalThis.vipDesktop;
    expect(isDesktopShell()).toBe(false);
  });

  test('isDesktopShell true when preload API present', () => {
    globalThis.vipDesktop = { openFile: async () => ({ canceled: true }) };
    expect(isDesktopShell()).toBe(true);
  });

  test('pickAudioFile returns File from IPC buffer', async () => {
    const buffer = new ArrayBuffer(8);
    globalThis.vipDesktop = {
      openFile: async () => ({
        canceled: false,
        filePath: 'C:\\Music\\podcast.wav',
        buffer,
      }),
    };
    const file = await pickAudioFile();
    expect(file).not.toBeNull();
    expect(file.name).toBe('podcast.wav');
    expect(file.type).toBe('audio/wav');
  });

  test('pickAudioFile returns null when canceled', async () => {
    globalThis.vipDesktop = {
      openFile: async () => ({ canceled: true }),
    };
    expect(await pickAudioFile()).toBeNull();
  });

  test('saveExportBlob forwards to vipDesktop.saveFile', async () => {
    globalThis.vipDesktop = {
      openFile: async () => ({ canceled: true }),
      saveFile: jest.fn(async () => ({ canceled: false, filePath: '/tmp/out.wav' })),
    };
    const blob = new Blob(['RIFF'], { type: 'audio/wav' });
    const result = await saveExportBlob(blob, { defaultName: 'out.wav' });
    expect(result.canceled).toBe(false);
    expect(result.filePath).toBe('/tmp/out.wav');
    expect(globalThis.vipDesktop.saveFile).toHaveBeenCalledWith(
      expect.objectContaining({ defaultName: 'out.wav' })
    );
  });

  test('filtersForFilename maps extensions', () => {
    expect(filtersForFilename('stem.mp3')[0].extensions).toEqual(['mp3']);
    expect(filtersForFilename('stem.wav')[0].extensions).toEqual(['wav']);
  });
});

describe('pickAndIngestFile', () => {
  afterEach(() => {
    delete globalThis.vipDesktop;
  });

  test('throws outside desktop shell', async () => {
    await expect(pickAndIngestFile()).rejects.toThrow(/Electron desktop shell/);
  });
});
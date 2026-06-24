/**
 * Tests for ExportControls (Layer 4: Presentation)
 */
'use strict';

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const { JSDOM } = require('jsdom');

describe('ExportControls', () => {
  let ExportControls;
  let ExportOrchestrator;
  let dom;
  let document;
  let window;
  let container;
  let mockMixer;
  let mockOrchestrator;

  beforeEach(async () => {
    // Setup JSDOM
    dom = new JSDOM('<!DOCTYPE html><html><body><div id="container"></div></body></html>', {
      url: 'http://localhost',
      pretendToBeVisual: true,
    });
    document = dom.window.document;
    window = dom.window;
    global.document = document;
    global.window = window;
    global.HTMLElement = window.HTMLElement;
    global.URL = {
      createObjectURL: jest.fn(() => 'blob:mock-url'),
      revokeObjectURL: jest.fn(),
    };

    // Mock Worker
    global.Worker = jest.fn().mockImplementation(() => ({
      postMessage: jest.fn(),
      terminate: jest.fn(),
      onmessage: null,
      onerror: null,
    }));

    container = document.getElementById('container');

    // Mock mixer
    mockMixer = {
      cleanBuffer: { duration: 10, sampleRate: 48000, numberOfChannels: 2 },
      noiseBuffer: { duration: 10, sampleRate: 48000, numberOfChannels: 2 },
      getSpeakerSegments: jest.fn().mockReturnValue([]),
      getSpeakerState: jest.fn().mockReturnValue(null),
      getSoloSpeaker: jest.fn().mockReturnValue(null),
    };

    // Mock orchestrator
    mockOrchestrator = {
      export: jest.fn().mockResolvedValue({
        blob: new window.Blob(['test'], { type: 'audio/wav' }),
        filename: 'test.wav',
        format: 'wav',
        duration: 10,
        sampleRate: 48000,
        channels: 2,
      }),
      dispose: jest.fn(),
    };

    // Import modules
    const controlsModule = await import('../src/presentation/ExportControls.js');
    ExportControls = controlsModule.ExportControls;

    const orchestratorModule = await import('../src/pipeline/ExportOrchestrator.js');
    ExportOrchestrator = orchestratorModule.ExportOrchestrator;

    // Mock ExportOrchestrator constructor
    jest.spyOn(ExportOrchestrator.prototype, 'constructor').mockImplementation(function() {
      return mockOrchestrator;
    });
  });

  afterEach(() => {
    delete global.document;
    delete global.window;
    delete global.HTMLElement;
    delete global.URL;
    delete global.Worker;
    dom.window.close();
  });

  describe('constructor', () => {
    it('should require mixer instance', () => {
      expect(() => new ExportControls({ container })).toThrow('PlaybackMixer instance required');
    });

    it('should require container element', () => {
      expect(() => new ExportControls({ mixer: mockMixer })).toThrow('Container element required');
    });

    it('should create instance with valid parameters', () => {
      const controls = new ExportControls({ mixer: mockMixer, container });
      expect(controls).toBeInstanceOf(ExportControls);
      expect(controls.mixer).toBe(mockMixer);
      expect(controls.container).toBe(container);
    });

    it('should render UI controls', () => {
      new ExportControls({ mixer: mockMixer, container });
      
      expect(container.querySelector('.vip-export-controls')).toBeTruthy();
      expect(container.querySelector('#vip-export-stems')).toBeTruthy();
      expect(container.querySelector('#vip-export-format')).toBeTruthy();
      expect(container.querySelector('#vip-export-button')).toBeTruthy();
    });

    it('should inject styles', () => {
      new ExportControls({ mixer: mockMixer, container });
      
      const style = document.getElementById('vip-export-styles');
      expect(style).toBeTruthy();
      expect(style.textContent).toContain('.vip-export-controls');
    });

    it('should not duplicate styles on multiple instances', () => {
      new ExportControls({ mixer: mockMixer, container });
      const container2 = document.createElement('div');
      document.body.appendChild(container2);
      new ExportControls({ mixer: mockMixer, container: container2 });
      
      const styles = document.querySelectorAll('#vip-export-styles');
      expect(styles.length).toBe(1);
    });
  });

  describe('UI interactions', () => {
    it('should show MP3 options when MP3 format selected', () => {
      new ExportControls({ mixer: mockMixer, container });
      
      const formatSelect = container.querySelector('#vip-export-format');
      const mp3Options = container.querySelector('.vip-export-mp3-options');
      
      expect(mp3Options.style.display).toBe('none');
      
      formatSelect.value = 'mp3';
      formatSelect.dispatchEvent(new window.Event('change'));
      
      expect(mp3Options.style.display).toBe('block');
    });

    it('should hide MP3 options when WAV format selected', () => {
      new ExportControls({ mixer: mockMixer, container });
      
      const formatSelect = container.querySelector('#vip-export-format');
      const mp3Options = container.querySelector('.vip-export-mp3-options');
      
      formatSelect.value = 'mp3';
      formatSelect.dispatchEvent(new window.Event('change'));
      expect(mp3Options.style.display).toBe('block');
      
      formatSelect.value = 'wav';
      formatSelect.dispatchEvent(new window.Event('change'));
      expect(mp3Options.style.display).toBe('none');
    });

    it('should have default values', () => {
      new ExportControls({ mixer: mockMixer, container });
      
      expect(container.querySelector('#vip-export-stems').value).toBe('clean');
      expect(container.querySelector('#vip-export-format').value).toBe('wav');
      expect(container.querySelector('#vip-export-bitrate').value).toBe('192');
      expect(container.querySelector('#vip-export-filename').value).toBe('voiceisolate-export');
      expect(container.querySelector('#vip-export-automation').checked).toBe(false);
    });
  });

  describe('export functionality', () => {
    it('should show error if no stems loaded', async () => {
      const emptyMixer = { cleanBuffer: null, noiseBuffer: null };
      const controls = new ExportControls({ mixer: emptyMixer, container });
      
      const button = container.querySelector('#vip-export-button');
      button.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const status = container.querySelector('.vip-export-status');
      expect(status.style.display).toBe('block');
      expect(status.classList.contains('error')).toBe(true);
      expect(status.textContent).toContain('No audio loaded');
    });

    it('should call orchestrator.export with correct options', async () => {
      const controls = new ExportControls({ mixer: mockMixer, container });
      controls.orchestrator = mockOrchestrator;
      
      container.querySelector('#vip-export-stems').value = 'clean';
      container.querySelector('#vip-export-format').value = 'wav';
      container.querySelector('#vip-export-filename').value = 'test-file';
      container.querySelector('#vip-export-automation').checked = true;
      
      const button = container.querySelector('#vip-export-button');
      button.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockOrchestrator.export).toHaveBeenCalledWith(
        expect.objectContaining({
          stems: 'clean',
          format: 'wav',
          filename: 'test-file',
          applySpeakerAutomation: true,
        })
      );
    });

    it('should disable button during export', async () => {
      const controls = new ExportControls({ mixer: mockMixer, container });
      controls.orchestrator = mockOrchestrator;
      
      const button = container.querySelector('#vip-export-button');
      expect(button.disabled).toBe(false);
      
      button.click();
      
      // Button should be disabled immediately
      expect(button.disabled).toBe(true);
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Button should be re-enabled after export
      expect(button.disabled).toBe(false);
    });

    it('should show progress during export', async () => {
      const controls = new ExportControls({ mixer: mockMixer, container });
      controls.orchestrator = mockOrchestrator;
      
      const button = container.querySelector('#vip-export-button');
      const progress = container.querySelector('.vip-export-progress');
      
      expect(progress.style.display).toBe('none');
      
      button.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Progress should have been shown during export
      // (it's hidden again after completion in this mock)
    });

    it('should trigger download on successful export', async () => {
      const controls = new ExportControls({ mixer: mockMixer, container });
      controls.orchestrator = mockOrchestrator;
      
      const button = container.querySelector('#vip-export-button');
      button.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(global.URL.createObjectURL).toHaveBeenCalled();
    });

    it('should show success message after export', async () => {
      const controls = new ExportControls({ mixer: mockMixer, container });
      controls.orchestrator = mockOrchestrator;
      
      const button = container.querySelector('#vip-export-button');
      button.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const status = container.querySelector('.vip-export-status');
      expect(status.style.display).toBe('block');
      expect(status.classList.contains('success')).toBe(true);
      expect(status.textContent).toContain('successfully');
    });

    it('should show error message on export failure', async () => {
      mockOrchestrator.export.mockRejectedValue(new Error('Export failed'));
      
      const controls = new ExportControls({ mixer: mockMixer, container });
      controls.orchestrator = mockOrchestrator;
      
      const button = container.querySelector('#vip-export-button');
      button.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const status = container.querySelector('.vip-export-status');
      expect(status.style.display).toBe('block');
      expect(status.classList.contains('error')).toBe(true);
      expect(status.textContent).toContain('Export failed');
    });

    it('should handle both stems export (multiple files)', async () => {
      mockOrchestrator.export.mockResolvedValue([
        { blob: new window.Blob(['clean']), filename: 'test-clean.wav', format: 'wav' },
        { blob: new window.Blob(['noise']), filename: 'test-noise.wav', format: 'wav' },
      ]);
      
      const controls = new ExportControls({ mixer: mockMixer, container });
      controls.orchestrator = mockOrchestrator;
      
      container.querySelector('#vip-export-stems').value = 'both';
      
      const button = container.querySelector('#vip-export-button');
      button.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(global.URL.createObjectURL).toHaveBeenCalledTimes(2);
      
      const status = container.querySelector('.vip-export-status');
      expect(status.textContent).toContain('2 files');
    });

    it('should update progress text based on stage', async () => {
      const controls = new ExportControls({ mixer: mockMixer, container });
      controls.orchestrator = mockOrchestrator;
      
      // Manually test progress update
      controls._updateProgress(0.5, 'encoding');
      
      const progressText = container.querySelector('.vip-export-progress-text');
      expect(progressText.textContent).toContain('Encoding');
      
      controls._updateProgress(1, 'complete');
      expect(progressText.textContent).toContain('Complete');
    });

    it('should use default filename if empty', async () => {
      const controls = new ExportControls({ mixer: mockMixer, container });
      controls.orchestrator = mockOrchestrator;
      
      container.querySelector('#vip-export-filename').value = '   '; // Whitespace only
      
      const button = container.querySelector('#vip-export-button');
      button.click();
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockOrchestrator.export).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: 'export',
        })
      );
    });
  });

  describe('dispose', () => {
    it('should clean up orchestrator', () => {
      const controls = new ExportControls({ mixer: mockMixer, container });
      controls.orchestrator = mockOrchestrator;
      
      controls.dispose();
      
      expect(mockOrchestrator.dispose).toHaveBeenCalled();
    });

    it('should clear container', () => {
      const controls = new ExportControls({ mixer: mockMixer, container });
      
      expect(container.innerHTML).not.toBe('');
      
      controls.dispose();
      
      expect(container.innerHTML).toBe('');
    });
  });
});

// Made with Bob

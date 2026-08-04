/**
 * Tests for IsolationModeSelector (Layer 4: Presentation)
 */
'use strict';

let IsolationModeSelector, ISOLATION_MODES, DEFAULT_MODE, MODE_IDS, getMode, isValidMode;

beforeAll(async () => {
  const module = await import('../src/presentation/IsolationModeSelector.js');
  IsolationModeSelector = module.IsolationModeSelector;
  ISOLATION_MODES = module.ISOLATION_MODES;
  DEFAULT_MODE = module.DEFAULT_MODE;
  MODE_IDS = module.MODE_IDS;
  getMode = module.getMode;
  isValidMode = module.isValidMode;
});

describe('IsolationModeSelector', () => {
  let mockDocument;
  let mockSelector;
  let mockDescription;

  beforeEach(() => {
    // Create mock DOM elements
    mockSelector = {
      id: 'isolationModeSelector',
      value: 'standard',
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    };

    mockDescription = {
      id: 'isolationModeDescription',
      innerHTML: '',
    };

    mockDocument = {
      getElementById: jest.fn((id) => {
        if (id === 'isolationModeSelector') return mockSelector;
        if (id === 'isolationModeDescription') return mockDescription;
        return null;
      }),
    };
  });

  describe('Constants', () => {
    test('ISOLATION_MODES contains all expected modes', () => {
      expect(ISOLATION_MODES).toHaveProperty('standard');
      expect(ISOLATION_MODES).toHaveProperty('maximum');
      expect(ISOLATION_MODES).toHaveProperty('noise-suppression');
      expect(ISOLATION_MODES).toHaveProperty('prompted');
    });

    test('Each mode has required properties', () => {
      Object.values(ISOLATION_MODES).forEach((mode) => {
        expect(mode).toHaveProperty('id');
        expect(mode).toHaveProperty('name');
        expect(mode).toHaveProperty('description');
        expect(mode).toHaveProperty('modelIds');
        expect(mode).toHaveProperty('estimatedTime');
        expect(mode).toHaveProperty('icon');
        expect(Array.isArray(mode.modelIds)).toBe(true);
        // Prompted Isolation is USM-only (empty modelIds is intentional).
        if (mode.id !== 'prompted') {
          expect(mode.modelIds.length).toBeGreaterThan(0);
        }
      });
    });

    test('Standard mode uses bsrnn_vocals', () => {
      expect(ISOLATION_MODES.standard.modelIds).toEqual(['bsrnn_vocals']);
    });

    test('Maximum mode chains bsrnn_vocals and rnnoise', () => {
      expect(ISOLATION_MODES.maximum.modelIds).toEqual(['bsrnn_vocals', 'rnnoise']);
    });

    test('Noise suppression mode uses rnnoise only', () => {
      expect(ISOLATION_MODES['noise-suppression'].modelIds).toEqual(['rnnoise']);
    });

    test('DEFAULT_MODE is standard', () => {
      expect(DEFAULT_MODE).toBe('standard');
    });

    test('MODE_IDS contains all mode keys', () => {
      expect(MODE_IDS).toContain('standard');
      expect(MODE_IDS).toContain('maximum');
      expect(MODE_IDS).toContain('noise-suppression');
      expect(MODE_IDS).toContain('prompted');
      expect(MODE_IDS.length).toBe(4);
    });

    test('Prompted Isolation is offline-only USM query route', () => {
      expect(ISOLATION_MODES.prompted.offlineOnly).toBe(true);
      expect(ISOLATION_MODES.prompted.usmMode).toBe('query');
      expect(ISOLATION_MODES.prompted.modelIds).toEqual([]);
    });
  });

  describe('getMode()', () => {
    test('Returns correct mode for valid id', () => {
      expect(getMode('standard')).toBe(ISOLATION_MODES.standard);
      expect(getMode('maximum')).toBe(ISOLATION_MODES.maximum);
      expect(getMode('noise-suppression')).toBe(ISOLATION_MODES['noise-suppression']);
    });

    test('Returns default mode for invalid id', () => {
      expect(getMode('invalid')).toBe(ISOLATION_MODES[DEFAULT_MODE]);
      expect(getMode('')).toBe(ISOLATION_MODES[DEFAULT_MODE]);
      expect(getMode(null)).toBe(ISOLATION_MODES[DEFAULT_MODE]);
    });
  });

  describe('isValidMode()', () => {
    test('Returns true for valid modes', () => {
      expect(isValidMode('standard')).toBe(true);
      expect(isValidMode('maximum')).toBe(true);
      expect(isValidMode('noise-suppression')).toBe(true);
    });

    test('Returns false for invalid modes', () => {
      expect(isValidMode('invalid')).toBe(false);
      expect(isValidMode('')).toBe(false);
      expect(isValidMode(null)).toBe(false);
      expect(isValidMode(undefined)).toBe(false);
    });
  });

  describe('Constructor', () => {
    test('Creates instance with default options', () => {
      const selector = new IsolationModeSelector();
      expect(selector.currentMode).toBe(DEFAULT_MODE);
      expect(selector.selectorId).toBe('isolationModeSelector');
      expect(selector.descriptionId).toBe('isolationModeDescription');
    });

    test('Accepts custom options', () => {
      const selector = new IsolationModeSelector({
        document: mockDocument,
        selectorId: 'customSelector',
        descriptionId: 'customDescription',
        initialMode: 'maximum',
      });
      expect(selector.currentMode).toBe('maximum');
      expect(selector.selectorId).toBe('customSelector');
      expect(selector.descriptionId).toBe('customDescription');
    });

    test('Accepts onChange callback', () => {
      const onChange = jest.fn();
      const selector = new IsolationModeSelector({ onChange });
      expect(selector.onChange).toBe(onChange);
    });
  });

  describe('currentModelIds getter', () => {
    test('Returns model IDs for current mode', () => {
      const selector = new IsolationModeSelector({ initialMode: 'standard' });
      expect(selector.currentModelIds).toEqual(['bsrnn_vocals']);
    });

    test('Updates when mode changes', () => {
      const selector = new IsolationModeSelector({ initialMode: 'standard' });
      selector.setMode('maximum');
      expect(selector.currentModelIds).toEqual(['bsrnn_vocals', 'rnnoise']);
    });
  });

  describe('bind()', () => {
    test('Returns true when selector element exists', () => {
      const selector = new IsolationModeSelector({ document: mockDocument });
      expect(selector.bind()).toBe(true);
    });

    test('Returns false when selector element missing', () => {
      mockDocument.getElementById = jest.fn(() => null);
      const selector = new IsolationModeSelector({ document: mockDocument });
      expect(selector.bind()).toBe(false);
    });

    test('Sets initial value on selector', () => {
      const selector = new IsolationModeSelector({
        document: mockDocument,
        initialMode: 'maximum',
      });
      selector.bind();
      expect(mockSelector.value).toBe('maximum');
    });

    test('Adds change event listener', () => {
      const selector = new IsolationModeSelector({ document: mockDocument });
      selector.bind();
      expect(mockSelector.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });

    test('Updates description on bind', () => {
      const selector = new IsolationModeSelector({ document: mockDocument });
      selector.bind();
      expect(mockDescription.innerHTML).toContain('Standard');
      expect(mockDescription.innerHTML).toContain('Band-Split RNN vocal extraction');
    });
  });

  describe('setMode()', () => {
    test('Changes mode successfully', () => {
      const selector = new IsolationModeSelector({ document: mockDocument });
      expect(selector.setMode('maximum')).toBe(true);
      expect(selector.currentMode).toBe('maximum');
    });

    test('Returns false for invalid mode', () => {
      const selector = new IsolationModeSelector({ document: mockDocument });
      expect(selector.setMode('invalid')).toBe(false);
      expect(selector.currentMode).toBe(DEFAULT_MODE);
    });

    test('Returns false when mode unchanged', () => {
      const selector = new IsolationModeSelector({ document: mockDocument });
      expect(selector.setMode('standard')).toBe(false);
    });

    test('Updates selector value when bound', () => {
      const selector = new IsolationModeSelector({ document: mockDocument });
      selector.bind();
      selector.setMode('maximum');
      expect(mockSelector.value).toBe('maximum');
    });
  });

  describe('Mode change handling', () => {
    test('Emits custom event on mode change', () => {
      const selector = new IsolationModeSelector({ document: mockDocument });
      selector.bind();

      // Simulate user changing selector
      mockSelector.value = 'maximum';
      const changeHandler = mockSelector.addEventListener.mock.calls[0][1];
      changeHandler();

      expect(mockSelector.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'isolationmodechange',
          detail: expect.objectContaining({
            mode: 'maximum',
            modelIds: ['bsrnn_vocals', 'rnnoise'],
            previousMode: 'standard',
          }),
        })
      );
    });

    test('Calls onChange callback', () => {
      const onChange = jest.fn();
      const selector = new IsolationModeSelector({
        document: mockDocument,
        onChange,
      });
      selector.bind();

      mockSelector.value = 'maximum';
      const changeHandler = mockSelector.addEventListener.mock.calls[0][1];
      changeHandler();

      expect(onChange).toHaveBeenCalledWith('maximum');
    });

    test('Ignores invalid mode changes', () => {
      const onChange = jest.fn();
      const selector = new IsolationModeSelector({
        document: mockDocument,
        onChange,
      });
      selector.bind();

      mockSelector.value = 'invalid';
      const changeHandler = mockSelector.addEventListener.mock.calls[0][1];
      changeHandler();

      expect(onChange).not.toHaveBeenCalled();
      expect(mockSelector.value).toBe('standard'); // Reverted
    });

    test('Ignores unchanged mode', () => {
      const onChange = jest.fn();
      const selector = new IsolationModeSelector({
        document: mockDocument,
        onChange,
      });
      selector.bind();

      mockSelector.value = 'standard';
      const changeHandler = mockSelector.addEventListener.mock.calls[0][1];
      changeHandler();

      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('getCurrentModeDefinition()', () => {
    test('Returns full mode definition', () => {
      const selector = new IsolationModeSelector({ initialMode: 'maximum' });
      const def = selector.getCurrentModeDefinition();
      expect(def).toBe(ISOLATION_MODES.maximum);
      expect(def.name).toBe('Maximum Isolation');
      expect(def.modelIds).toEqual(['bsrnn_vocals', 'rnnoise']);
    });
  });

  describe('dispose()', () => {
    test('Removes event listeners', () => {
      const selector = new IsolationModeSelector({ document: mockDocument });
      selector.bind();
      selector.dispose();
      expect(mockSelector.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });

    test('Clears references', () => {
      const selector = new IsolationModeSelector({ document: mockDocument });
      selector.bind();
      selector.dispose();
      expect(selector._selector).toBeNull();
      expect(selector._description).toBeNull();
      expect(selector._boundHandler).toBeNull();
    });
  });
});

// Made with Bob

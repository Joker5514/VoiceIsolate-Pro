const fs = require('fs');
const path = require('path');

const stateCodePath = path.join(__dirname, '../public/app/pipeline-state.js');
const stateCode = fs.readFileSync(stateCodePath, 'utf8');

// Load PipelineState class by evaluating the file content
const PipelineState = new Function('module', 'window', stateCode + '\nreturn module.exports || window.PipelineState;')({}, {});

describe('PipelineState', () => {
  let state;

  const mockSliders = {
    group1: [
      { id: 'slider1', val: 50, min: 0, max: 100, step: 1, label: 'Slider 1', rt: true },
      { id: 'slider2', val: 0.5, min: 0.0, max: 1.0, step: 0.1, label: 'Slider 2' }
    ],
    group2: [
      { id: 'slider3', val: -10, min: -20, max: 20, step: 5, label: 'Slider 3' }
    ]
  };

  beforeEach(() => {
    state = new PipelineState();
  });

  describe('Registration and Default Values', () => {
    test('registerSliders correctly parses slider definitions', () => {
      state.registerSliders(mockSliders);

      expect(state.get('slider1')).toBe(50);
      expect(state.get('slider2')).toBe(0.5);
      expect(state.get('slider3')).toBe(-10);

      const meta = state.getMeta('slider1');
      expect(meta.group).toBe('group1');
      expect(meta.min).toBe(0);
      expect(meta.rt).toBe(true);
    });

    test('get() returns undefined for unregistered keys', () => {
      expect(state.get('nonexistent')).toBeUndefined();
    });

    test('keys() returns all registered slider IDs', () => {
      state.registerSliders(mockSliders);
      const keys = state.keys();
      expect(keys).toHaveLength(3);
      expect(keys).toContain('slider1');
      expect(keys).toContain('slider2');
      expect(keys).toContain('slider3');
    });

    test('grouped() returns sliders organized by group', () => {
      state.registerSliders(mockSliders);
      const groups = state.grouped();

      expect(Object.keys(groups)).toHaveLength(2);
      expect(groups.group1).toHaveLength(2);
      expect(groups.group2).toHaveLength(1);
      expect(groups.group1[0].id).toBe('slider1');
    });
  });

  describe('Value Setting and Clamping', () => {
    beforeEach(() => {
      state.registerSliders(mockSliders);
    });

    test('set() updates values correctly', () => {
      state.set('slider1', 75);
      expect(state.get('slider1')).toBe(75);
    });

    test('set() clamps values above maximum', () => {
      state.set('slider1', 150);
      expect(state.get('slider1')).toBe(100);
    });

    test('set() clamps values below minimum', () => {
      state.set('slider3', -50);
      expect(state.get('slider3')).toBe(-20);
    });

    test('set() rounds values to nearest step', () => {
      state.set('slider2', 0.54);
      expect(state.get('slider2')).toBe(0.5); // Round to 0.1 step

      state.set('slider2', 0.56);
      expect(state.get('slider2')).toBeCloseTo(0.6); // Round to 0.1 step
    });

    test('set() ignores tiny changes (less than 1% of step)', () => {
      state.set('slider1', 50);
    // Changes less than 0.01 step should be ignored\n    state.set('slider1', 50.005);\n    expect(state.get('slider1')).toBe(50);\n    expect(state.undo()).toBe(false); // No undo frame added
    });
  });

  describe('Pub/Sub Events', () => {
    beforeEach(() => {
      state.registerSliders(mockSliders);
    });

    test('on() registers per-key listeners', () => {
      const mockFn = jest.fn();
      state.on('slider1', mockFn);

      state.set('slider1', 60);
      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(mockFn).toHaveBeenCalledWith({
        key: 'slider1',
        value: 60,
        prev: 50,
        source: 'user'
      });

      // Changing other sliders shouldn't trigger it
      state.set('slider2', 0.8);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test('onAny() registers wildcard listeners', () => {
      const mockFn = jest.fn();
      state.onAny(mockFn);

      state.set('slider1', 60);
      state.set('slider2', 0.8);

      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    test('listener unsubscribe functions work', () => {
      const mockFn1 = jest.fn();
      const mockFnAny = jest.fn();

      const unsub1 = state.on('slider1', mockFn1);
      const unsubAny = state.onAny(mockFnAny);

      unsub1();
      unsubAny();

      state.set('slider1', 60);

      expect(mockFn1).not.toHaveBeenCalled();
      expect(mockFnAny).not.toHaveBeenCalled();
    });
  });

  describe('Undo/Redo Functionality', () => {
    beforeEach(() => {
      state.registerSliders(mockSliders);
    });

    test('undo() restores previous state', () => {
      state.set('slider1', 60);
      state.set('slider1', 70);
      state.set('slider2', 0.8);

      expect(state.get('slider1')).toBe(70);
      expect(state.get('slider2')).toBe(0.8);

      // Undo slider2
      const undone1 = state.undo();
      expect(undone1).toBe(true);
      expect(state.get('slider2')).toBe(0.5);
      expect(state.get('slider1')).toBe(70);

      // Undo slider1 to 60
      const undone2 = state.undo();
      expect(undone2).toBe(true);
      expect(state.get('slider1')).toBe(60);
    });

    test('redo() reapplies undone state', () => {
      state.set('slider1', 60);
      state.undo();
      expect(state.get('slider1')).toBe(50);

      const redone = state.redo();
      expect(redone).toBe(true);
      expect(state.get('slider1')).toBe(60);
    });

    test('undo() returns false when no history', () => {
      expect(state.undo()).toBe(false);
    });

    test('redo() returns false when no future', () => {
      expect(state.redo()).toBe(false);
    });

    test('setting new value clears redo stack', () => {
      state.set('slider1', 60);
      state.set('slider1', 70);
      state.undo(); // back to 60

      // New action clears future
      state.set('slider2', 0.8);
      expect(state.redo()).toBe(false);
    });

    test('history size is capped at maxHistory', () => {
      state._maxHistory = 3;

      state.set('slider1', 51);
      state.set('slider1', 52);
      state.set('slider1', 53);
      state.set('slider1', 54);

      // The 51 change should have fallen off the end
      expect(state._history.length).toBe(3);

      state.undo(); // to 53
      state.undo(); // to 52
      state.undo(); // to 51
      expect(state.undo()).toBe(false); // Can't go back to 50
    });
  });

  describe('Batch Mode', () => {
    beforeEach(() => {
      state.registerSliders(mockSliders);
    });

    test('batch mode defers notifications until commit', () => {
      const mockFn = jest.fn();
      state.onAny(mockFn);

      state.beginBatch();
      state.set('slider1', 60);
      state.set('slider2', 0.8);

      // Values should be updated immediately
      expect(state.get('slider1')).toBe(60);

      // But no notifications fired yet
      expect(mockFn).not.toHaveBeenCalled();

      state.commitBatch('preset');

      // Now they should fire
      expect(mockFn).toHaveBeenCalledTimes(2);
      expect(mockFn).toHaveBeenCalledWith(expect.objectContaining({
        key: 'slider1',
        value: 60,
        source: 'preset'
      }));
    });

    test('batch creates only one undo frame', () => {
      state.beginBatch();
      state.set('slider1', 60);
      state.set('slider2', 0.8);
      state.commitBatch();

      expect(state._history.length).toBe(1);

      state.undo();

      expect(state.get('slider1')).toBe(50);
      expect(state.get('slider2')).toBe(0.5);
    });
  });

  describe('Export/Import', () => {
    beforeEach(() => {
      state.registerSliders(mockSliders);
    });

    test('export() creates plain object of all params', () => {
      state.set('slider1', 60);
      const exported = state.export();

      expect(exported).toEqual({
        slider1: 60,
        slider2: 0.5,
        slider3: -10
      });
    });

    test('import() loads values correctly', () => {
      state.import({
        slider1: 75,
        slider3: 15,
        unknown_param: 99 // Should be ignored
      });

      expect(state.get('slider1')).toBe(75);
      expect(state.get('slider2')).toBe(0.5); // Unchanged
      expect(state.get('slider3')).toBe(15);
      expect(state.get('unknown_param')).toBeUndefined();
    });

    test('import() creates a single undo frame', () => {
      state.import({ slider1: 75, slider3: 15 });

      expect(state._history.length).toBe(1);

      state.undo();
      expect(state.get('slider1')).toBe(50);
    });
  });

  describe('Worklet Broadcast', () => {
    let mockPort;

    beforeEach(() => {
      state.registerSliders(mockSliders);
      mockPort = { postMessage: jest.fn() };
      state.setWorkletPort(mockPort);
    });

    test('set() broadcasts RT params to worklet', () => {
      // slider1 is marked rt: true
      state.set('slider1', 60);
      expect(mockPort.postMessage).toHaveBeenCalledWith({
        type: 'param',
        key: 'slider1',
        value: 60
      });
    });

    test('set() does not broadcast non-RT params to worklet', () => {
      // slider2 is not marked rt
      state.set('slider2', 0.8);
      expect(mockPort.postMessage).not.toHaveBeenCalled();
    });

    test('commitBatch broadcasts bulk RT params to worklet', () => {
      state.beginBatch();
      state.set('slider1', 60); // rt
      state.set('slider2', 0.8); // not rt
      state.commitBatch();

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        type: 'paramBulk',
        params: {
          slider1: 60
        }
      });
    });

    test('ignores worklet source updates to prevent loops', () => {
      state.set('slider1', 60, { source: 'worklet' });

      // Value is updated
      expect(state.get('slider1')).toBe(60);

      // But not broadcasted back
      expect(mockPort.postMessage).not.toHaveBeenCalled();
    });
  });
});

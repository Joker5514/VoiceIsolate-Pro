const fs = require('fs');
const path = require('path');
const getAppCode = require('./helpers/get-app-code');

describe('VoiceIsolatePro.prototype.makeHarm', () => {
  let makeHarm;

  beforeAll(() => {
    // Read app.js (with slider-map.js imports resolved for eval compatibility)
    const appJsCode = getAppCode();

    // Setup global environment to safely evaluate the file
    // Mock the document object so DOMContentLoaded listener doesn't throw
    global.document = {
      addEventListener: () => {}
    };
    global.window = {};

    // Evaluate the code. To access the class locally, we can append an assignment.
    // The class is named VoiceIsolatePro. We append it to a new global so we can grab it.
    eval(appJsCode + '\n global.__TEST_VoiceIsolatePro = VoiceIsolatePro;');

    makeHarm = global.__TEST_VoiceIsolatePro.prototype.makeHarm;
  });

  afterAll(() => {
    delete global.document;
    delete global.window;
    delete global.__TEST_VoiceIsolatePro;
  });

  test('makeHarm should be defined on the prototype', () => {
    expect(typeof makeHarm).toBe('function');
  });

  test('makeHarm should return a Float32Array of length 44100', () => {
    const curve = makeHarm(0.5, 3);
    expect(curve).toBeInstanceOf(Float32Array);
    expect(curve.length).toBe(44100);
  });

  test('makeHarm values should be within [-1, 1]', () => {
    const curve = makeHarm(1.0, 8);
    let allWithinBounds = true;
    for (let i = 0; i < curve.length; i++) {
      if (curve[i] < -1.000001 || curve[i] > 1.000001) {
        allWithinBounds = false;
        break;
      }
    }
    expect(allWithinBounds).toBe(true);
  });

  test('makeHarm should be odd-symmetric', () => {
    const curve = makeHarm(0.5, 3);
    const mid = 22050; // 44100 / 2

    // Middle point should be close to 0
    expect(curve[mid]).toBeCloseTo(0, 5);

    // First point should be close to -1
    expect(curve[0]).toBeCloseTo(-1, 5);

    // The symmetric points should have opposite signs
    expect(curve[mid + 100]).toBeCloseTo(-curve[mid - 100], 5);
    expect(curve[44099]).toBeCloseTo(-curve[1], 5);
  });

  test('makeHarm with amount 0 should act as a soft clipper (not linear due to tanh(1))', () => {
    const amt = 0;
    const ord = 3;
    const curve = makeHarm(amt, ord);

    // Midpoint should be 0
    expect(curve[22050]).toBeCloseTo(0, 5);

    // It is effectively Math.tanh(x)/Math.tanh(1)
    const x = (10000 * 2) / 44100 - 1;
    const expected = Math.tanh(x) / Math.tanh(1);
    expect(curve[10000]).toBeCloseTo(expected, 5);
  });

  test('makeHarm with different orders creates different curves', () => {
    const curve1 = makeHarm(0.5, 3);
    const curve2 = makeHarm(0.5, 8);

    // They should differ at a point away from 0 and endpoints
    expect(curve1[10000]).not.toBeCloseTo(curve2[10000], 5);
  });
});

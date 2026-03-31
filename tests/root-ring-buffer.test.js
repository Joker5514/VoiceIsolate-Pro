const fs = require('fs');
const path = require('path');
const runRingBufferTests = require('./shared-ring-buffer-tests.js');

const ringBufferCode = fs.readFileSync(path.join(__dirname, '../ring-buffer.js'), 'utf8');

let SharedRingBuffer;
// Evaluate script in context to get class
const moduleMock = { exports: {} };
const windowMock = {};
new Function('module', 'window', ringBufferCode)(moduleMock, windowMock);

if (typeof moduleMock.exports === 'function') {
  SharedRingBuffer = moduleMock.exports;
} else if (windowMock.SharedRingBuffer) {
  SharedRingBuffer = windowMock.SharedRingBuffer;
} else {
  throw new Error("SharedRingBuffer not found in moduleMock.exports or windowMock");
}

runRingBufferTests(SharedRingBuffer, 'Root SharedRingBuffer');

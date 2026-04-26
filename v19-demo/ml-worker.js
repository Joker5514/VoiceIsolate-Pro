// VoiceIsolate Pro v19 — ML Worker (legacy demo, kept for reference)
// Active development is in public/app/ml-worker.js
'use strict';

importScripts('/lib/ort.min.js');

var models = {};

self.onmessage = function (e) {
  var type = e.data && e.data.type;
  if (type === 'init') {
    self.postMessage({ type: 'ready' });
  } else if (type === 'runVAD') {
    self.postMessage({ type: 'vadResult', result: [] });
  } else if (type === 'process') {
    self.postMessage({ type: 'processResult', output: e.data.input });
  }
};

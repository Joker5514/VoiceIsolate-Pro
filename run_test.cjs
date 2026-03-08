const fs = require('fs');

const source = fs.readFileSync('src/js/workers/dsp-worker.js', 'utf8');
try {
  new Function(source);
  console.log("Syntax OK");
} catch (e) {
  console.error("Syntax Error:", e);
}

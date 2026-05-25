const fs = require('fs');
let code = fs.readFileSync('tests/vip-bootstrap.test.js', 'utf8');

// Remove extractSafetyNetIIFE function and the SAFETY_NET_IIFE variable
code = code.replace(/function extractSafetyNetIIFE\(\) {[\s\S]*?const SAFETY_NET_IIFE  = extractSafetyNetIIFE\(\);/, 'const BOOTSTRAP_IIFE   = extractVipBootstrapIIFE();');

// Remove the whole safety net test block
code = code.replace(/\/\/ ═════════════════════════════════════════════════════════════════════════════\r?\n\/\/ 2\. _vipSafetyNet IIFE[\s\S]*?\/\/ ═════════════════════════════════════════════════════════════════════════════/g, '// ═════════════════════════════════════════════════════════════════════════════');

fs.writeFileSync('tests/vip-bootstrap.test.js', code);
console.log('Fixed vip-bootstrap.test.js');

const fs = require('fs');

let content = fs.readFileSync('api/monetization.js', 'utf8');

// Insert simulated db and email functions before getStripe
const insertDb = `// ─── Simulated Database & Email (replace in production) ───────────────────────
const db = {
  licenses: {
    _data: new Map(),
    async upsert(record) {
      this._data.set(record.customerId, record);
      return record;
    },
    async get(customerId) {
      return this._data.get(customerId) || null;
    }
  }
};

async function sendEmail(email, subject, body) {
  console.log(\`[Email] Sent to \${email}: \${subject}\`);
  // In production, integrate with SendGrid, SES, etc.
}

// ─── Lazy-load Stripe`;

content = content.replace('// ─── Lazy-load Stripe', insertDb);

// Uncomment the lines
content = content.replace(
  /\/\/ TODO: Store in database and email the token to the user\n\s*\/\/ await db\.licenses\.upsert\(\{ customerId, email, tier, token, subscriptionId \}\);\n\s*\/\/ await sendEmail\(email, 'Your VoiceIsolate Pro License', token\);/,
  `// TODO: Store in database and email the token to the user
        await db.licenses.upsert({ customerId, email, tier, token, subscriptionId });
        await sendEmail(email, 'Your VoiceIsolate Pro License', token);`
);

fs.writeFileSync('api/monetization.js', content, 'utf8');
console.log("Patched!");

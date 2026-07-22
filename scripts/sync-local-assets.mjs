#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pairs = [
  { from: join(root, 'node_modules', 'onnxruntime-web', 'dist'), to: join(root, 'public', 'app', 'vendor', 'onnxruntime-web') },
  { from: join(root, 'models'), to: join(root, 'public', 'app', 'models') },
];
for (const { from, to } of pairs) {
  if (!existsSync(from)) { console.warn(`[vip-assets] skipping missing source: ${from}`); continue; }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
  console.log(`[vip-assets] copied ${from} -> ${to}`);
}

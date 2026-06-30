import { list } from '@vercel/blob';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envLocalPath = join(__dirname, '..', '.env.local');

// Quick parser for .env.local to load BLOB_READ_WRITE_TOKEN
let token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  try {
    const content = readFileSync(envLocalPath, 'utf8');
    const match = content.match(/BLOB_READ_WRITE_TOKEN\s*=\s*["']?([^"\n\r']+)["']?/);
    if (match) {
      token = match[1];
    }
  } catch (e) {
    console.error('Could not read .env.local:', e.message);
  }
}

if (!token) {
  console.error('ERROR: BLOB_READ_WRITE_TOKEN not found.');
  process.exit(1);
}

async function main() {
  console.log('Listing Vercel Blobs...');
  const { blobs } = await list({ token });
  console.log(`Found ${blobs.length} blob(s):`);
  for (const b of blobs) {
    console.log(`- Path: ${b.pathname}`);
    console.log(`  URL:  ${b.url}`);
    console.log(`  Size: ${b.size} bytes`);
    console.log(`  Uploaded: ${b.uploadedAt}`);
    console.log('---');
  }
}

main().catch(err => {
  console.error('Error listing blobs:', err);
  process.exit(1);
});

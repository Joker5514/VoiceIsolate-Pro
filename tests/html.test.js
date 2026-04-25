/**
 * VoiceIsolate Pro — HTML Structure & Accessibility Tests
 * Verifies the pipeline progress bar has correct ARIA attributes across all HTML files.
 */

const fs = require('fs');
const path = require('path');

const htmlFiles = [
  { label: 'index.html (root)', filePath: path.join(__dirname, '../index.html') },
  { label: 'build/app/index.html', filePath: path.join(__dirname, '../build/app/index.html') },
  { label: 'public/app/index.html', filePath: path.join(__dirname, '../public/app/index.html') },
];

describe('Pipeline progress bar accessibility', () => {
  htmlFiles.forEach(({ label, filePath }) => {
    describe(label, () => {
      let html;

      beforeAll(() => {
        html = fs.readFileSync(filePath, 'utf8');
      });

      test('pipeBar element has id="pipeBar"', () => {
        expect(html).toContain('id="pipeBar"');
      });

      test('pipeBar element has role="progressbar"', () => {
        expect(html).toContain('role="progressbar"');
      });

      test('pipeBar element has aria-valuemin="0"', () => {
        expect(html).toContain('aria-valuemin="0"');
      });

      test('pipeBar element has aria-valuemax="100"', () => {
        expect(html).toContain('aria-valuemax="100"');
      });

      test('pipeBar element has aria-valuenow="0" as initial state', () => {
        expect(html).toContain('aria-valuenow="0"');
      });

      test('pipeBar element has aria-label="Processing progress"', () => {
        expect(html).toContain('aria-label="Processing progress"');
      });

      test('pipeBar ARIA attributes are on the same element as the pipe-bar class', () => {
        // All attributes must appear together on the .pipe-bar container, not scattered
        expect(html).toMatch(
          /class="pipe-bar"[^>]*id="pipeBar"|id="pipeBar"[^>]*class="pipe-bar"/
        );
      });

      test('pipeFill child element is still present inside pipeBar', () => {
        // The inner fill element must not have been removed when adding ARIA attrs
        expect(html).toContain('id="pipeFill"');
        expect(html).toContain('class="pipe-fill"');
      });
    });
  });
});

describe('Pipeline progress bar — structure integrity', () => {
  test('all three HTML files contain identical pipeBar markup', () => {
    const contents = htmlFiles.map(({ filePath }) => fs.readFileSync(filePath, 'utf8'));

    // Extract the pipe-bar line from each file for comparison
    const extractPipeBarLine = (html) => {
      const match = html.match(/<div[^>]+pipe-bar[^>]*>/);
      return match ? match[0] : null;
    };

    const [root, build, pub] = contents.map(extractPipeBarLine);
    expect(root).not.toBeNull();
    expect(root).toEqual(build);
    expect(root).toEqual(pub);
  });

  test('pipeBar does not have role="progressbar" on the inner pipeFill element', () => {
    htmlFiles.forEach(({ filePath }) => {
      const html = fs.readFileSync(filePath, 'utf8');
      // The pipeFill div should not carry the progressbar role
      expect(html).not.toMatch(/id="pipeFill"[^>]*role="progressbar"/);
    });
  });

  test('aria-valuemin is less than aria-valuemax (valid range)', () => {
    htmlFiles.forEach(({ filePath }) => {
      const html = fs.readFileSync(filePath, 'utf8');
      const minMatch = html.match(/aria-valuemin="(\d+)"/);
      const maxMatch = html.match(/aria-valuemax="(\d+)"/);
      expect(minMatch).not.toBeNull();
      expect(maxMatch).not.toBeNull();
      expect(Number(minMatch[1])).toBeLessThan(Number(maxMatch[1]));
    });
  });

  test('aria-valuenow is within the declared min/max range', () => {
    htmlFiles.forEach(({ filePath }) => {
      const html = fs.readFileSync(filePath, 'utf8');
      const minMatch = html.match(/aria-valuemin="(\d+)"/);
      const maxMatch = html.match(/aria-valuemax="(\d+)"/);
      const nowMatch = html.match(/aria-valuenow="(\d+)"/);
      expect(nowMatch).not.toBeNull();
      const min = Number(minMatch[1]);
      const max = Number(maxMatch[1]);
      const now = Number(nowMatch[1]);
      expect(now).toBeGreaterThanOrEqual(min);
      expect(now).toBeLessThanOrEqual(max);
    });
  });
});
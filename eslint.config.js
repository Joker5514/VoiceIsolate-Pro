/**
 * VoiceIsolate Pro — ESLint Configuration (Flat Config)
 * https://eslint.org/docs/latest/use/configure/configuration-files
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,

  // ── Broad catch-all: ALL public/app browser scripts ───────────────────────────
  // IMPORTANT: this must come BEFORE the worker-specific overrides below.
  // In flat config the last matching rule wins for scalar options (sourceType).
  // Workers override sourceType back to 'script' in their entries further down.
  {
    files: ['public/app/**/*.js', 'public/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',   // safe default for ESM files; workers override below
      globals: {
        ...globals.browser,
        ...globals.worker,
        importScripts:    'readonly',
        SharedRingBuffer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ── Specific file overrides (come after catch-all; later entries win) ─────────
  {
    files: ['public/app/app.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ort: 'readonly',
        THREE: 'readonly',
        module: 'readonly',
        PipelineState: 'readonly',
        PipelineOrchestrator: 'readonly',
        SpeakerRegistry: 'readonly',
        Auth: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', varsIgnorePattern: '^SLIDER_REGISTRY$' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
    },
  },
  {
    files: ['public/app/slider-map.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
    },
  },
  {
    files: ['public/app/vip-enhancements.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
    },
  },
  {
    // AudioWorklet processors — run in AudioWorkletGlobalScope (no import/export)
    files: ['public/app/dsp-processor.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script', // overrides catch-all's 'module'
      globals: {
        ...globals.browser,
        AudioWorkletProcessor: 'readonly',
        registerProcessor:     'readonly',
        currentFrame:          'readonly',
        currentTime:           'readonly',
        sampleRate:            'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Offline DSP Web Worker — uses importScripts (no import/export)
    files: ['public/app/dsp-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script', // overrides catch-all's 'module'
      globals: {
        ...globals.worker,
        importScripts: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // ML inference Web Worker — uses importScripts to load ONNX Runtime
    files: ['public/app/ml-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script', // overrides catch-all's 'module'
      globals: {
        ...globals.worker,
        importScripts: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // revenuecat.js — browser script with optional CommonJS export guard
    files: ['public/app/revenuecat.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script', // overrides catch-all's 'module'
      globals: {
        ...globals.browser,
        module: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
    },
  },
  {
    // session-persist.js — browser script with optional CommonJS export guard
    files: ['public/app/session-persist.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script', // overrides catch-all's 'module'
      globals: {
        ...globals.browser,
        module: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
    },
  },

  // ── Backend / tooling ─────────────────────────────────────────────────────────
  {
    // API handlers (api/ and api-routes/) — Node.js ESM
    files: ['api/**/*.js', 'api-routes/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Dev server — Node.js ESM
    files: ['server.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Build/validation scripts (.js/.cjs) and Jest test files — CommonJS
    files: ['scripts/**/*.js', 'scripts/**/*.cjs', 'tests/**/*.test.js', 'tests/**/*.js', 'tests/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },
  {
    // ESM scripts (.mjs)
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },

  {
    // UMD modules — browser + CJS dual-mode (need module/define globals)
    files: [
      'public/app/health-monitor.js',
      'public/app/shared-memory-schema.js',
      'public/app/state-manager.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        module: 'readonly',
        define: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ── Ignores ───────────────────────────────────────────────────────────────────
  {
    ignores: [
      'node_modules/**',
      'v19-demo/**',
      'public/lib/**',   // third-party minified vendor files (ort, three.js)
      'android/**',
      'ios/**',
      'build/**',
      'fastlane/**',
    ],
  },
];

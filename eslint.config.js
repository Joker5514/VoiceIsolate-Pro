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
        module:           'readonly',   // UMD export guards in legacy files
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', varsIgnorePattern: '^SLIDER_REGISTRY$', caughtErrorsIgnorePattern: '^_' }],
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
    },
  },

  // ── Top-level public pages (landing.js etc.) — browser ES modules ────────────
  {
    files: ['public/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
    },
  },

  // ── Stem-Split & Live-Mix architecture (src/ — see CLAUDE.md §2) ─────────────
  {
    // Layers 1/3/4 — browser ES modules
    files: ['src/core/**/*.js', 'src/pipeline/**/*.js', 'src/presentation/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
    },
  },
  {
    // Layer 2 — classic Web Worker (importScripts, no import/export)
    files: ['src/workers/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.worker,
        importScripts: 'readonly',
        ort: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
    },
  },
  {
    // Layer 2 — AudioWorklet processors (*Processor.js files)
    // Run in AudioWorkletGlobalScope (no import/export, special globals)
    files: ['src/workers/*Processor.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
        currentFrame: 'readonly',
        currentTime: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true }],
    },
  },
  {
    // Layer 2 — module workers (spawned with { type: 'module' }); they import
    // src/core/ directly, so sourceType flips back to 'module'.
    files: ['src/workers/DiarizationWorker.js', 'src/workers/SpectralCleanupWorker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.worker },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Electron main + preload — Node.js CommonJS (Blueprint v2.1 §VIII)
    files: ['electron/**/*.cjs', 'electron/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Dev server + security middleware — Node.js ESM
    files: ['server.js', 'server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$', caughtErrorsIgnorePattern: '^_' }],
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
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

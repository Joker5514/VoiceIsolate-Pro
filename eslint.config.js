/**
 * VoiceIsolate Pro — ESLint Configuration (Flat Config)
 * https://eslint.org/docs/latest/use/configure/configuration-files
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['public/app/app.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ort: 'readonly',        // ONNX Runtime Web
        THREE: 'readonly',      // Three.js
        module: 'readonly',     // CommonJS export check for testing
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
    files: ['public/app/dsp-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        currentFrame: 'readonly',
        currentTime: 'readonly',
        sampleRate: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['public/app/ml-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.worker,
        ort: 'readonly',        // ONNX Runtime Web (via importScripts)
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
    files: ['scripts/**/*.js', 'tests/**/*.test.js'],
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
    ignores: ['node_modules/**', 'v19-demo/**'],
  },
];

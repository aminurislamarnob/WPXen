'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');
const prettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'release/**', 'assets/bin/**'],
  },

  js.configs.recommended,

  // Electron main process + CommonJS configs (module.exports / require).
  {
    files: [
      'electron/**/*.cjs',
      'eslint.config.js',
      'postcss.config.js',
      'tailwind.config.js',
    ],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },

  // ESM tooling configs (import/export, run through Vite's loader).
  {
    files: ['vite.config.js', 'vitest.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Renderer — React + JSX, browser globals.
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  // Tests — Node + Vitest globals.
  {
    files: ['test/**/*.{js,cjs}', '**/*.test.{js,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Turn off stylistic rules that Prettier owns.
  prettier,
];

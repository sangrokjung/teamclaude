export default [
  // Browser report assets are classic <script> files that share globals across
  // tags, not Node modules; this Node-oriented config cannot lint them
  // meaningfully. They are exercised by the token-report workflow instead.
  { ignores: ['skills/token-usage-report/assets/**'] },
  {
    files: ['scripts/subscription-monitor-browser.js'],
    languageOptions: {
      globals: {
        sleep: 'readonly',
        closeTab: 'readonly',
        snapshot: 'readonly',
        googleAccounts: 'readonly',
        gmail: 'readonly',
        listBrowserTabs: 'readonly',
        openTab: 'readonly',
      },
    },
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        setInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Buffer: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-constant-condition': 'warn',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'eqeqeq': ['warn', 'smart'],
    },
  },
];

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist', 'dist-electron', 'release', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Renderer: React in the browser.
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    // Main process + preload and build scripts: Node.
    files: ['electron/**/*.ts', 'scripts/**/*.{js,mjs,ts}'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    // Unused args are allowed when explicitly discarded with a leading _.
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
)

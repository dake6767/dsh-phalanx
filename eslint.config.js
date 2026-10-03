import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import architecture from './scripts/architecture-eslint.mjs'

export default tseslint.config(
  { ignores: ['coverage/', '**/dist/', '**/node_modules/', 'playwright-report/', 'test-results/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'admin-ui/src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx,mts}'],
    plugins: { 'dsh-phalanx': architecture },
    rules: Object.fromEntries(Object.keys(architecture.rules).map(name => [`dsh-phalanx/${name}`, 'error'])),
  },
  {
    files: ['tests/fixtures/**/*.mjs', 'containers/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
)

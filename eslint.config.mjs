import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import stylistic from '@stylistic/eslint-plugin';

export default defineConfig(
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'release/**', 'src/server/generated/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      curly: ['error', 'all'],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: 'function' },
        { blankLine: 'always', prev: 'function', next: '*' },
        { blankLine: 'always', prev: 'export', next: 'export' },
      ],
    },
  },
  { files: ['**/*.mjs'], ...tseslint.configs.disableTypeChecked },
  prettier,
);

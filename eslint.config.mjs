import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config, linted from the repo root in one pass (`pnpm lint`). Deliberately
 * not a per-package turbo task: one config, one resolution root, no package
 * silently linting with no rules at all.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/db/generated/**',
      'services/redirect/**',
      'data/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.es2022 } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // info for process lifecycle (listening, draining), never per request: a
      // line per redirect is a line per click.
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      // TypeScript reports undefined identifiers with full type information.
      'no-undef': 'off',
    },
  },
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      /**
       * The web app talks to the API and to nothing else.
       *
       * No Prisma, no Redis, no click worker: reports come from
       * `GET /links/:id/analytics`, never from the rollup tables read in a server
       * component. A shortcut like that works in development, bypasses ownership
       * checks and the rate limiter, and makes the web container need database
       * credentials it must not have. `@links/link-rules` and `@links/shared` ARE
       * allowed: they are pure.
       */
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@links/db', '@links/click-worker', '@prisma/*', 'ioredis', 'pg'],
              message:
                'apps/web reaches data through the API only (lib/api.ts). Add an endpoint instead.',
            },
          ],
        },
      ],
    },
  },
  {
    /**
     * `consistent-type-imports` is off for the Nest app, and not as a preference:
     * Nest resolves constructor dependencies from `emitDecoratorMetadata`, and an
     * `import type` erases the class so injection fails at boot with an error that
     * points nowhere near the import.
     */
    files: ['apps/api/src/**/*.ts', 'apps/api/test/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    // Seeds, scripts, tests and the E2E suite may talk to stdout.
    files: [
      'packages/db/prisma/**/*.mts',
      'scripts/**/*.mjs',
      '**/*.test.ts',
      'e2e/**/*.ts',
      '**/integration/**/*.ts',
      'services/click-worker/test/**/*.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', 'apps/api/test/**/*.ts', '**/integration/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);

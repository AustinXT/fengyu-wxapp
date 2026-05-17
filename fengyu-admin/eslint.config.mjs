import { FlatCompat } from '@eslint/eslintrc'
import tsEslintPlugin from '@typescript-eslint/eslint-plugin'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({ baseDirectory: __dirname })

const config = [
  ...compat.extends('next/core-web-vitals'),
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'dist/**',
    ],
  },
  {
    // Register the typescript-eslint plugin so existing inline
    // `// eslint-disable-next-line @typescript-eslint/no-explicit-any`
    // comments resolve. We don't enable the rule itself — code already
    // uses targeted disables, mass-enabling would be a separate cleanup.
    plugins: {
      '@typescript-eslint': tsEslintPlugin,
    },
  },
  {
    // Soft-land pre-existing lint findings as warnings to avoid blocking
    // CI on issues unrelated to the no-restricted-imports guard below.
    // These rules pre-existed (just never enforced — next lint had no
    // config). Tightening them is a separate hygiene pass.
    rules: {
      'react/no-unescaped-entities': 'warn',
      'react/no-children-prop': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      '@next/next/no-img-element': 'warn',
      '@next/next/no-html-link-for-pages': 'warn',
    },
  },
  {
    rules: {
      /**
       * Guard against the recurring foot-gun:
       *   import { hasPermission } from '@/lib/auth'         // wrong — TypeError at runtime
       *   import { requirePermission } from '@/lib/auth'     // wrong — TypeError at runtime
       *
       * `hasRole` / `getRoleLabel` live in @/lib/auth.
       * `hasPermission` / `requirePermission` / `requireAnyPermission` /
       * `scopeCondition` / `PERMISSION_MATRIX` / `isAdminScope` / `isInScope` /
       * `buildScopeWhere` / `computeActions` / `expandScopeStoreIds`
       * live in @/lib/permissions.
       *
       * Crossing the modules silently 500'd the refunds detail page (caught
       * 2026-05-17 in link-4 E2E). Both `next lint` (no config) and tsc
       * (skipped) failed to gate it pre-merge.
       */
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/lib/permissions',
              importNames: ['hasRole', 'getRoleLabel'],
              message:
                "Import hasRole / getRoleLabel from '@/lib/auth' — these are not exported by @/lib/permissions.",
            },
            {
              name: '@/lib/auth',
              importNames: [
                'hasPermission',
                'requirePermission',
                'requireAnyPermission',
                'scopeCondition',
                'isAdminScope',
                'isInScope',
                'PERMISSION_MATRIX',
                'buildScopeWhere',
                'computeActions',
                'expandScopeStoreIds',
              ],
              message:
                "Import permission/scope helpers from '@/lib/permissions' — these are not exported by @/lib/auth.",
            },
          ],
        },
      ],
    },
  },
  {
    /**
     * Enforce that every Server Action export in src/actions/ goes through
     * the withPermission / withAnyPermission HOF (see @/lib/with-permission).
     *
     * Three rules together close the gap:
     *  1. (reverse) ban bare `export async function` — forces HOF rewrite
     *  2. (positive) require const init to be a CallExpression
     *  3. (positive) require the callee to be withPermission / withAnyPermission
     *
     * S2 ships these as `warn` during the migration; S5 flips to `error`.
     * `src/actions/auth.ts` is ignored — it owns no-session public entries
     * (login / logout / getSessionFromCookie / checkMustChange).
     */
    files: ['src/actions/**/*.ts'],
    ignores: ['src/actions/**/*.test.ts', 'src/actions/auth.ts'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'ExportNamedDeclaration > FunctionDeclaration[async=true]',
          message:
            'Server Actions must be wrapped with withPermission(...) or withAnyPermission(...). Use: export const myAction = withPermission("action:key", async (session, ...args) => { ... })',
        },
        {
          selector:
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[init.type!="CallExpression"]',
          message:
            'Exported Server Action must be initialized by calling withPermission(...) or withAnyPermission(...).',
        },
        {
          selector:
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[init.type="CallExpression"][init.callee.type="Identifier"][init.callee.name!=/^(withPermission|withAnyPermission)$/]',
          message:
            'Exported Server Action initializer must be withPermission or withAnyPermission (got a different callee).',
        },
      ],
    },
  },
]

export default config

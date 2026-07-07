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
    
    plugins: {
      '@typescript-eslint': tsEslintPlugin,
    },
  },
  {
    
    
    
    
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
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='slice'][callee.object.type='CallExpression'][callee.object.callee.type='MemberExpression'][callee.object.callee.property.name='toISOString']",
          message:
            "禁止 `xxx.toISOString().slice(...)` 切片日期 —— 按 UTC 截断会跨午夜重号。改用 SQL 端 to_char(NOW() AT TIME ZONE 'Asia/Shanghai',...) 或 JS dayjs.tz('Asia/Shanghai').format(...)",
        },
      ],
    },
  },
  {
    rules: {
      
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
    
    files: ['src/actions/**/*.ts'],
    ignores: ['src/actions/**/*.test.ts', 'src/actions/auth.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
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
        
        {
          selector:
            "BinaryExpression[operator=/^===?$/][left.property.name='code'][right.value=/^[0-9]{5}$/]",
          message:
            "禁止裸 `.code === '23xxx'` 判断 pg 错误码 —— drizzle 0.45 把码包进 err.cause，永不命中。改用 pgErrorCode(err)（@/lib/pg-error）。",
        },
        {
          selector:
            "BinaryExpression[operator=/^===?$/][left.expression.property.name='code'][right.value=/^[0-9]{5}$/]",
          message:
            "禁止裸 `err?.code === '23xxx'` 判断 pg 错误码 —— drizzle 0.45 把码包进 err.cause，永不命中。改用 pgErrorCode(err)（@/lib/pg-error）。",
        },
      ],
    },
  },
]

export default config

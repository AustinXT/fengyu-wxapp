'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../sync-workfine.js'), 'utf8')

for (const args of [[], ['--sync-only'], ['--import-only'], ['--dry-run']]) {
  test(`实际main路由 ${args.join(' ') || '默认'} 的同步/导入边界`, async () => {
    const calls = []
    const module = { exports: {} }
    const fakeRequire = id => {
      if (id === 'mssql') return { connect: async () => ({ close: async () => {} }) }
      if (id === 'pg') return { Pool: class { async query() {} async end() {} } }
      if (id === 'crypto') return require('node:crypto')
      if (id === './recalc-all-customer-types') return {}
      if (id === './_lib/assert-db-target') return require('../_lib/assert-db-target')
      throw new Error(`未预期依赖 ${id}`)
    }
    fakeRequire.main = null
    const context = vm.createContext({ module, require: fakeRequire, process: { argv: ['node','sync-workfine',...args], env: { DATABASE_URL: 'postgres://test:test@101.34.242.103:5433/fengyu_wxapp' }, exit: code => { throw new Error(`exit ${code}`) } }, console: {log(){},error(){}}, URL })
    vm.runInContext(source, context)
    for (const name of ['syncOrgNodesAndStores','syncEmployees','syncPermissionRoles','syncCustomers','importProductCategories','importProducts','verify']) {
      context[name] = async (...params) => { calls.push({ name, dryRun: params.at(-1) }) }
    }
    await context.main()
    assert.equal(calls.some(row=>row.name==='syncCustomers'), !args.includes('--import-only'))
    assert.equal(calls.some(row=>row.name==='importProducts'), !args.includes('--sync-only'))
    assert.equal(calls.some(row=>row.name==='verify'), !args.includes('--dry-run'))
    if (args.includes('--dry-run')) assert.equal(calls.find(row=>row.name==='syncCustomers').dryRun,true)
  })
}

'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { compareCandidates } = require('../audit-customer-binding')
const staff = [
 { employee_id: 'E1', name: '甲', store_name: '门店A', is_resigned: false },
 { employee_id: 'E2', name: '乙', store_name: '门店A', is_resigned: false },
 { employee_id: 'E3', name: '同名', store_name: '门店A', is_resigned: false },
 { employee_id: 'E4', name: '同名', store_name: '门店A', is_resigned: false },
]
const user = { user_id: 'U1', phone: '13900000001', customer_type: '会员客', cohort: '2026-08', opened_by: 'E1', employees: ['E2'] }
test('三依据冲突不能被一致人数吞掉；WorkFine姓名按来源门店映射', () => {
 const r = compareCandidates([user], staff, [{ phone: user.phone, employee_id: '甲', store_name: '门店A' }])
 const g = r.summary.groups['member-2026-08']
 assert.equal(g.threeUnique, 1); assert.equal(g.threeConflict, 1); assert.equal(g.conflict, 1)
 assert.deepEqual(r.details[0].candidates.workfine, ['E1'])
 assert.deepEqual(user.employees, ['E2']) // 不改调查输入，更不回写绑定
})
test('姓名+来源门店仍不唯一时输出歧义，不挑第一个当可回填对象', () => {
 const r = compareCandidates([user], staff, [{ phone: user.phone, employee_id: '同名', store_name: '门店A' }])
 assert.equal(r.summary.groups.all.workfine.ambiguous, 1)
 assert.equal(r.summary.groups.all.workfine.unique, 0)
 assert.equal(r.summary.sourceShape.ambiguousNames, 1)
})
test('源数据未提供和提供但无绑定分开，不把不可用误记为0人', () => {
 const unavailable = compareCandidates([user], staff, null).summary
 assert.equal(unavailable.workfineAvailable, false); assert.equal(unavailable.groups.all.workfine, null)
 const empty = compareCandidates([user], staff, []).summary
 assert.equal(empty.workfineAvailable, true); assert.equal(empty.groups.all.workfine.unique, 0)
})
test('已有关联customer_id不擅自退到同手机号其它源客户；服务首单多主操记歧义', () => {
 const r = compareCandidates([{ ...user, customer_id: 'C1', employees: ['E1', 'E2'] }], staff,
   [{ customer_id: 'C2', phone: user.phone, employee_id: 'E1' }])
 assert.equal(r.summary.groups.all.workfine.any, 0)
 assert.equal(r.summary.groups.all.service.ambiguous, 1)
})
test('CLI拒绝apply，不能把调查误运行成回填', () => {
 const r = spawnSync(process.execPath, [require.resolve('../audit-customer-binding'), '--apply'], { encoding: 'utf8' })
 assert.equal(r.status, 1); assert.match(r.stderr, /用法/); assert.equal(r.stdout, '')
})


test('私有输出不覆旧档、权限0600；仓库路径及指向仓库的软链拒绝', () => {
 const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
 const { writePrivateReport } = require('../audit-customer-binding')
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fy-audit-output-'))
 try {
  const out = path.join(root, 'report.json')
  writePrivateReport(out, { fixture: true })
  assert.equal(fs.statSync(out).mode & 0o777, 0o600)
  assert.throws(() => writePrivateReport(out, { overwritten: true }), { code: 'EEXIST' })
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { fixture: true })
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo); fs.mkdirSync(path.join(repo, '.git'))
  assert.throws(() => writePrivateReport(path.join(repo, 'pii.json'), {}), /Git仓库/)
  const link = path.join(root, 'backup-link'); fs.symlinkSync(repo, link)
  assert.throws(() => writePrivateReport(path.join(link, 'pii.json'), {}), /Git仓库/)
  assert.equal(fs.existsSync(path.join(repo, 'pii.json')), false)
 } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('空主操不构成候选或冲突，空白PG匹配键归一后可映射', () => {
 const r = compareCandidates([{ ...user, phone: ' 13900000001 ', employees: [null, '', ' '] }], staff,
   [{ phone: '13900000001', employee_id: '甲', store_name: '门店A' }])
 assert.equal(r.summary.groups.all.service.any, 0)
 assert.equal(r.summary.groups.all.service.unique, 0)
 assert.equal(r.summary.groups.all.conflict, 0)
 assert.deepEqual(r.details[0].candidates.workfine, ['E1'])
})

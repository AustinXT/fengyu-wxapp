'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const { summarize, AUDIT_SQL } = require('../audit-customer-type-transitions')
test('全量差分识别升级与不变；#545 起降档被单调门挡住并单列 protected', () => {
  const rows = [
    // 只升不降：计算小美客但现值会员客 → new_type 保留会员客，计入 protected
    { old_type: '会员客', new_type: '会员客', computed_type: '小美客', ordered_30d: true },
    { old_type: '小美客', new_type: '小美客', computed_type: '流量客', ordered_30d: false },
    { old_type: '流量客', new_type: '会员客', computed_type: '会员客', ordered_30d: true },
    { old_type: '会员客', new_type: '会员客', computed_type: '会员客', ordered_30d: true },
  ]
  const out = summarize(rows)
  assert.equal(out.scope, 4); assert.equal(out.changed, 1); assert.equal(out.unchanged, 3)
  assert.equal(out.downgrades, 0); assert.equal(out.downgradesOrdered30d, 0)
  assert.equal(out.transitions.length, 1)
  assert.equal(out.protectedByMonotonic, 2)
  assert.equal(out.protectedBreakdown.length, 2)
  assert.equal(out.protectedBreakdown.find(b => b.level === '会员客').ordered30d, 1)
})
test('历史降级轨迹（真实降档行）仍能被 summarize 记录，不被单调门统计吞掉', () => {
  const rows = [{ old_type: '会员客', new_type: '小美客', computed_type: '小美客', ordered_30d: true }]
  const out = summarize(rows)
  assert.equal(out.downgrades, 1); assert.equal(out.downgradesOrdered30d, 1)
  assert.equal(out.protectedByMonotonic, 0)
})
test('未知旧档位拒绝出部分名单', () => {
  assert.throws(() => summarize([{ old_type: '未知', new_type: '会员客', computed_type: '会员客' }]), /未知顾客档位/)
})
test('未知计算档位同样拒绝出部分名单', () => {
  assert.throws(() => summarize([{ old_type: '会员客', new_type: '会员客', computed_type: '未知' }]), /未知顾客档位/)
})
test('只读审计CLI拒绝apply，不能误执行数据治理', () => {
  const r = spawnSync(process.execPath, [require.resolve('../audit-customer-type-transitions'), '--apply'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgresql://unused' } })
  assert.equal(r.status, 1); assert.match(r.stderr, /用法/); assert.equal(r.stdout, '')
})
test('导入三个治理脚本无连接/打印/执行副作用；审计复用真实SQL且剔除测试账号', () => {
  const r = execFileSync(process.execPath, ['-e', "for(const f of ['recalc-all-customer-types','recalc-became-member-at','backfill-membership-upgrade-doc-type']) require('./db/scripts/'+f)"], { cwd: require('node:path').resolve(__dirname, '../../..'), encoding: 'utf8' })
  assert.equal(r, '')
  assert.match(AUDIT_SQL, /u.name IS DISTINCT FROM '谢廷\(测试\)'/)
  assert.doesNotMatch(AUDIT_SQL, /CREATE TEMP/)
})


test('私有输出不覆旧档、权限0600；仓库路径及指向仓库的软链拒绝', () => {
 const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
 const { writePrivateReport } = require('../audit-customer-type-transitions')
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

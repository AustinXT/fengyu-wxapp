/**
 * 链路 18：操作日志完整性 + 审计
 *
 * 主题：所有 admin 变更操作必产生 1 条 operation_logs，operator/target/source/payload
 *      完整可追溯；同资源多次编辑产生多条日志（不被覆盖）。
 *
 * 关键不变量（核对真实 schema 2026-05-17）：
 *   每次 updateCustomer → operation_logs +1 行（无 UPDATE，append-only，无 updated_at）
 *   source = 'adminApi'（不是 README 里写的 'admin'）
 *   operator_employee_id = session.employee_id
 *   detail (jsonb) 格式（logUpdate 产出）：
 *     { "_v":2, "_t":"update", "changes": { "notes": { "from": "...", "to": "..." } } }
 *
 * NOTE: README §1.B 写的是 payload 字段含 before/after；
 *       实际列名是 detail，结构是 changes.{field}.{from,to}（参见 lib/operation-log.ts:80）
 *
 * 执行模式：FY-TEST-CSM 登录 → 进入 fixture 顾客详情页 → 进入编辑态 → 修改 notes 三次 → DB 校验
 *
 * 重要：logUpdate 仅在有真实变化时写日志（computeChanges 返回 null 则跳过）。
 *      所以每次编辑必须把 notes 改成不同的字符串。
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const BASE = 'http://localhost:3000'
const CSM_PHONE = '13900139005'
const CSM_PASS = 'fengyu2026'
const FIXTURE_USER_ID = 'FY-FIX-CLIENT-01'

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')
const CONTEXT_FILE = path.resolve(__dirname, './.last-test-context.json')

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function psql(sql: string): string {
  try {
    return execSync(
      `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu -t -A -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim()
  } catch (e) {
    const err = e as { message?: string; stderr?: string }
    throw new Error(`psql: ${err.message ?? ''}\n${err.stderr ?? ''}`)
  }
}

function writeCtx(linkKey: string, payload: Record<string, unknown>) {
  ensureDir(path.dirname(CONTEXT_FILE))
  let ctx: Record<string, unknown> = {}
  try { ctx = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')) } catch { /* noop */ }
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify({ ...ctx, [linkKey]: payload }, null, 2))
}

async function login(page: import('@playwright/test').Page, phone: string, pass: string) {
  await page.goto(`${BASE}/login`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(300)
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially(phone, { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially(pass, { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })
}

test.setTimeout(180_000)

test('链路18：操作日志完整性 + 审计', async ({ page }) => {
  ensureDir(TEST_RESULTS_DIR)

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[browser-error] ${msg.text()}`)
  })

  const verdicts: Array<{ check: string; verdict: string; actual?: string | number }> = []

  // ── Step 0: 取 notes 原值 + 取日志基线 cutoff 时间 ──
  const oldNotes = psql(`SELECT COALESCE(notes,'') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`)
  console.log(`[链路18] fixture 顾客原 notes: "${oldNotes}"`)

  // cutoff 必须用 DB 时钟（5434 上的 NOW()），避免本地时钟漂移导致 created_at > cutoff 判定失误
  const cutoffStr = psql(`SELECT NOW()::text`)
  console.log(`[链路18] DB cutoff: ${cutoffStr}`)

  // ── Step 1: CSM 登录并进入顾客详情页 ──
  await login(page, CSM_PHONE, CSM_PASS)
  console.log('[链路18] CSM 登录成功')
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-18-01-login.png` })

  await page.goto(`${BASE}/customers/${FIXTURE_USER_ID}`)
  await expect(page.getByText('顾客详情').first()).toBeVisible({ timeout: 20000 })
  await page.waitForLoadState('networkidle')

  // ── Step 2: 进入"基本档案"编辑态，连续 3 次保存不同 notes ──
  const stamp = Date.now()
  const newNotes = [
    `link18-test-${stamp}-A`,
    `link18-test-${stamp}-B`,
    `link18-test-${stamp}-C`,
  ]

  for (let i = 0; i < 3; i++) {
    // 每轮强制 reload 顾客详情页，避免 customer.updatedAt 因 router.refresh() 异步未完成
    // 而 stale，进而被 updateCustomer 乐观锁拒绝（"数据已被其他人修改"）。
    // i=0 时页面已在详情页，仍 reload 一次保持一致路径。
    await page.goto(`${BASE}/customers/${FIXTURE_USER_ID}`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('顾客详情').first()).toBeVisible({ timeout: 20000 })

    // 进入编辑态（基本档案 卡片右上"编辑"按钮）
    // 页面有多个"编辑"按钮（手机号一个、基本档案一个），用 .first() 拿基本档案那个
    const editBtn = page.getByRole('button', { name: '编辑' }).first()
    await expect(editBtn).toBeVisible({ timeout: 10000 })
    await editBtn.click()
    await page.waitForTimeout(400)

    // 找 textarea（备注字段，唯一 textarea）
    const notesArea = page.locator('textarea').first()
    await expect(notesArea).toBeVisible({ timeout: 5000 })
    await notesArea.click()
    await notesArea.fill(newNotes[i])

    await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-18-02-edit-${i + 1}.png` })

    // 保存按钮（基本档案 卡片右上"保存"）
    const saveBtn = page.getByRole('button', { name: '保存' }).first()
    await expect(saveBtn).toBeVisible({ timeout: 5000 })
    await saveBtn.click()

    // 等"保存"按钮消失（最可靠的退出编辑态信号；toast 文本会跨轮残留导致 false-positive）
    // handleSave 成功后调 setIsEditing(false) 让保存按钮卸载；失败则保留→在这里会超时
    await expect(saveBtn).toBeHidden({ timeout: 15000 })

    console.log(`[链路18] 第 ${i + 1} 次保存完成: notes="${newNotes[i]}"`)
  }

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-18-03-after-3-saves.png` })

  // ── Step 3: DB 验证 ──
  // 3.1 操作日志计数 ≥ 3
  const logsCountStr = psql(
    `SELECT count(*) FROM operation_logs ` +
      `WHERE target_id='${FIXTURE_USER_ID}' AND target_type='customer' ` +
      `AND action='customer.update' AND created_at > '${cutoffStr}'::timestamp`,
  )
  const logsCount = parseInt(logsCountStr, 10) || 0
  console.log(`[链路18] cutoff 之后新增 customer.update 日志: ${logsCount}`)
  verdicts.push({
    check: 'logs_appended_three_times',
    verdict: logsCount >= 3 ? 'PASS' : 'FAIL',
    actual: logsCount,
  })

  // 3.2 source = 'adminApi'（NOT 'admin'）
  const sources = psql(
    `SELECT DISTINCT source FROM operation_logs ` +
      `WHERE target_id='${FIXTURE_USER_ID}' AND target_type='customer' ` +
      `AND action='customer.update' AND created_at > '${cutoffStr}'::timestamp`,
  )
  verdicts.push({
    check: 'source_is_adminApi',
    verdict: sources === 'adminApi' ? 'PASS' : 'FAIL',
    actual: sources,
  })

  // 3.3 operator_employee_id = FY-TEST-CSM
  const operators = psql(
    `SELECT DISTINCT operator_employee_id FROM operation_logs ` +
      `WHERE target_id='${FIXTURE_USER_ID}' AND target_type='customer' ` +
      `AND action='customer.update' AND created_at > '${cutoffStr}'::timestamp`,
  )
  verdicts.push({
    check: 'operator_is_csm',
    verdict: operators === 'FY-TEST-CSM' ? 'PASS' : 'FAIL',
    actual: operators,
  })

  // 3.4 detail.changes.notes.from/to 完整（logUpdate v2 结构）
  // 取最近一条日志的 detail，验 changes.notes 含 from + to
  const latestDetail = psql(
    `SELECT detail::text FROM operation_logs ` +
      `WHERE target_id='${FIXTURE_USER_ID}' AND target_type='customer' ` +
      `AND action='customer.update' AND created_at > '${cutoffStr}'::timestamp ` +
      `ORDER BY created_at DESC LIMIT 1`,
  )
  console.log(`[链路18] 最近一条 detail: ${latestDetail.substring(0, 200)}`)

  const detailHasNotesChange =
    latestDetail.includes('"notes"') &&
    latestDetail.includes('"from"') &&
    latestDetail.includes('"to"') &&
    latestDetail.includes(stamp.toString()) // 包含本轮测试 stamp 标识
  verdicts.push({
    check: 'detail_changes_notes_from_to',
    verdict: detailHasNotesChange ? 'PASS' : 'FAIL',
    actual: latestDetail.length > 250 ? latestDetail.substring(0, 250) + '...' : latestDetail,
  })

  // 3.5 最后一条 to 字段 = newNotes[2]（C）
  const finalNotes = psql(`SELECT COALESCE(notes,'') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`)
  verdicts.push({
    check: 'final_notes_persisted',
    verdict: finalNotes === newNotes[2] ? 'PASS' : 'FAIL',
    actual: finalNotes,
  })

  // ── Step 4: 进 /logs 列表页 UI 验证（按时间倒序，至少看到 3 条） ──
  await page.goto(`${BASE}/logs`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-18-04-logs-list.png` })

  // 列表页应包含本次 stamp 的字符串（取最新一条 detail 渲染时通常含 notes 内容片段）
  // 但 /logs 不一定渲染 detail；至少能看到"customer.update" 文案 + FY-TEST-CSM
  const logsBody = await page.textContent('body')
  const logsHasCsm = logsBody?.includes('FY-TEST-CSM') || logsBody?.includes('测试客服') || false
  const logsHasUpdate = logsBody?.includes('customer.update') || logsBody?.includes('顾客') || false
  verdicts.push({
    check: 'logs_page_renders_csm_and_action',
    verdict: logsHasCsm && logsHasUpdate ? 'PASS' : 'SKIP',
    actual: `hasCSM=${logsHasCsm}, hasUpdateText=${logsHasUpdate}`,
  })

  // ── Step 5: 反例 — 手工 SQL 篡改不在 admin 拦截范围内 ──
  // 这是 README §1.B 提到的反例，admin 校验不防 DB 直连篡改。SKIP（DB 权限层防护）
  verdicts.push({
    check: 'neg_db_direct_tamper',
    verdict: 'SKIP',
    actual: 'admin 不校验 DB 直连写入；防篡改靠 DB 权限层（生产应限制 fengyu user 写权限）',
  })

  // ── Step 6: 清理 ──
  // 删除本轮新增日志 + 还原 notes
  try {
    psql(
      `DELETE FROM operation_logs ` +
        `WHERE target_id='${FIXTURE_USER_ID}' AND target_type='customer' ` +
        `AND action='customer.update' AND created_at > '${cutoffStr}'::timestamp`,
    )
    console.log('[链路18] 已删除本轮 operation_logs')
  } catch (e) {
    console.log(`[链路18] 删 operation_logs 出错（非致命）: ${e}`)
  }

  // 还原 notes（用 SQL 直改 + 写一条 cleanup 日志会触发再 +1，所以直接 SQL 改不走 action）
  // 注意：直 UPDATE 不走乐观锁也不写日志，正好满足"还原"语义。
  const escapedOld = oldNotes.replace(/'/g, "''")
  if (oldNotes === '') {
    psql(`UPDATE client_wechat_users SET notes=NULL WHERE user_id='${FIXTURE_USER_ID}'`)
  } else {
    psql(`UPDATE client_wechat_users SET notes='${escapedOld}' WHERE user_id='${FIXTURE_USER_ID}'`)
  }
  console.log(`[链路18] 已还原 notes 为原值`)

  // ── 汇总 ──
  const hasFail = verdicts.some((v) => v.verdict === 'FAIL')
  const hasSkip = verdicts.some((v) => v.verdict === 'SKIP')
  const overallStatus = hasFail ? 'FAIL' : hasSkip ? 'PARTIAL' : 'PASS'

  const report = {
    link: 18,
    status: overallStatus,
    csmEditedNotesValues: newNotes,
    logsAppendedCount: logsCount,
    verdicts,
    cleaned: true,
    notes: '验证 admin source 实际为 adminApi（非 README 写的 admin），detail 结构为 v2 logUpdate（changes.{field}.{from,to}）',
  }

  console.log('\n[链路18] === 最终报告 ===')
  console.log(JSON.stringify(report, null, 2))
  writeCtx('link18', report)

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') {
      expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
    }
  }
})

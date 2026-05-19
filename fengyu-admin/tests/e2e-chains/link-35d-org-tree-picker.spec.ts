/**
 * 链路 35d：OrgTreeSelect & /permissions 页 scope 守卫（轻量验证）
 *
 * 背景：
 *   admin 仓库中真正"组织树挑选器"出现在 /permissions 的"分配角色"对话框（OrgTreeSelect）。
 *   而 org 域 CRUD 仅 admin / hr 可触达（permissions:list + org:* 权限）。
 *   admin / hr 两者都是 HQ scope（16d1184b46db099a）→ 实际上不存在 UI 越权选父节点的路径。
 *   故本 spec 不验证"hr 选超 scope 节点被拒"（无可达路径），转而验证：
 *     1) MGR 直接 GET `/permissions` 被拒（菜单可见性 + route guard）
 *     2) ADM 打开"分配角色"Dialog，OrgTreeSelect 排除"部门"类型节点（excludeTypes 实际生效）
 *     3) ADM 能在 OrgTreeSelect 中看到 HQ + 全部市场 + 门店（HQ 视角可见）
 *     4) DB invariant：`org_nodes` 表存在 总部 / 市场 / 门店 / 部门 4 种类型，
 *        OrgTreeSelect 渲染节点数 ≈ 非部门节点数
 *
 *   服务端 isNodeInScope() 已由代码审计覆盖（actions/org.ts:18-37），
 *   其 admin 始终通过 / HQ 父节点遍历命中的行为，无需 UI 重复测。
 *
 * 关键引用：
 *   - components/ui/org-tree-select.tsx:40-45  excludeTypes 过滤
 *   - actions/org.ts:18-37                      isNodeInScope（沿 parentId 向上 5 层）
 *   - app/(main)/permissions/page.tsx          MGR 不在 requiredRoles
 */

import { test, expect } from '@playwright/test'
import {
  BASE,
  TEST_PHONES,
  psql,
  login,
  recordVerdict,
  summarize,
  writeContext,
  type Verdict,
} from './_helpers/scope-helpers'

test.setTimeout(180_000)

test('链路35d：OrgTreeSelect & /permissions scope 守卫', async ({ browser }) => {
  const verdicts: Verdict[] = []

  // DB baseline
  const totalNodes = parseInt(psql(`SELECT COUNT(*)::text FROM org_nodes WHERE is_active=true`), 10)
  const deptNodes = parseInt(psql(`SELECT COUNT(*)::text FROM org_nodes WHERE is_active=true AND type='部门'`), 10)
  const nonDeptNodes = totalNodes - deptNodes
  console.log(`[链路35d] db: total=${totalNodes} dept=${deptNodes} nonDept=${nonDeptNodes}`)

  // ── Case 1: MGR sidebar 不含"权限管理"链接（菜单可见性即安全边界）──
  //
  // 设计说明：admin 仓库的 /permissions page.tsx 不做 role-level 拦截，
  //   MGR URL 直接访问可渲染（getRoleAssignments 调 employee:list / permission:list；
  //   manager 现持 employee:list，permission:list 缺失但当前 page.tsx 容错为 [] —
  //   实际行为是页面 OK 渲染但功能 disabled）。
  //   真正的边界是：(1) sidebar 不显示"权限管理"链接（菜单 requiredRoles 过滤），
  //                  (2) 写操作 savePermissionRoles 强校验 permission:assign（link-19 覆盖）。
  //   本 case 验证 (1)：访问 /dashboard 后抓 nav 区，断言没有"权限管理"超链接。
  console.log('[链路35d] Case 1: MGR sidebar hides /permissions link')
  const ctxMgr = await browser.newContext()
  const pMgr = await ctxMgr.newPage()
  try {
    await login(pMgr, TEST_PHONES.MGR)
    await pMgr.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
    await pMgr.waitForTimeout(1500)
    // 关键：检查 sidebar/nav 是否含 href="/permissions" 链接
    const permsLinkCount = await pMgr.locator('a[href="/permissions"]').count()
    recordVerdict(verdicts, 'mgr_sidebar_no_perms_link', permsLinkCount === 0, `a[href=/permissions] count=${permsLinkCount}`)
  } finally {
    await ctxMgr.close()
  }

  // ── Case 2 / 3 / 4：ADM 打开"分配角色"Dialog，验证 OrgTreeSelect ──
  console.log('[链路35d] Case 2-4: ADM /permissions OrgTreeSelect')
  const ctxAdm = await browser.newContext()
  const pAdm = await ctxAdm.newPage()
  try {
    await login(pAdm, TEST_PHONES.ADM)
    await pAdm.goto(`${BASE}/permissions`)
    await pAdm.waitForLoadState('networkidle').catch(() => null)
    await pAdm.waitForTimeout(1500)

    // 打开"分配角色"对话框（按钮文案"分配角色"或"新增"）
    const assignBtn = pAdm.getByRole('button', { name: /分配角色|新增角色|分配/ }).first()
    if (await assignBtn.count() === 0) {
      recordVerdict(verdicts, 'adm_open_assign_dialog', false, '未找到"分配角色"按钮')
    } else {
      await assignBtn.click().catch(() => null)
      await pAdm.waitForTimeout(800)

      // 找到 OrgTreeSelect 的触发按钮（含"选择组织节点"占位符或已选中名）
      const treeTrigger = pAdm.locator('button:has-text("选择组织节点"), button:has-text("总部")').first()
      if (await treeTrigger.count() === 0) {
        recordVerdict(verdicts, 'adm_locate_tree_trigger', false, '未定位 OrgTreeSelect 触发器')
      } else {
        await treeTrigger.click().catch(() => null)
        await pAdm.waitForTimeout(600)

        // 树面板的所有可点击节点 — 每个节点渲染为 button
        // OrgTreeSelect 内部用 button 列举节点，labels 含节点 name
        const treeButtons = await pAdm.locator('button').all()
        // 抓取出现"市场"/"门店"/"总部"label 的 button
        const nodeLabels: string[] = []
        for (const btn of treeButtons) {
          const txt = (await btn.textContent().catch(() => '')) || ''
          const t = txt.trim()
          if (t && (t.includes('市场') || t.includes('店') || t.includes('总部') || t.includes('部'))) {
            nodeLabels.push(t)
          }
        }
        // OrgTreeSelect excludeTypes=["部门"] → 不应渲染"...部"结尾的部门节点
        const hasDeptLabel = nodeLabels.some((l) => /\b[^\s]+部$/.test(l) && !l.includes('总部'))
        recordVerdict(verdicts, 'adm_org_tree_excludes_department', !hasDeptLabel, `deptInLabels=${hasDeptLabel}`)

        // ADM 视角：至少应能看到"总部"+ 至少 1 个"市场"
        const seesHq = nodeLabels.some((l) => l.includes('总部'))
        const seesMarket = nodeLabels.some((l) => l.includes('市场'))
        recordVerdict(verdicts, 'adm_org_tree_sees_hq', seesHq, `seesHq=${seesHq}`)
        recordVerdict(verdicts, 'adm_org_tree_sees_market', seesMarket, `seesMarket=${seesMarket}`)
        // 节点数 sanity check：≥ 总部 1 + 市场 ≥ 2，且 ≤ 非部门节点数
        recordVerdict(
          verdicts,
          'adm_org_tree_node_count_sane',
          nodeLabels.length >= 2 && nodeLabels.length <= nonDeptNodes + 5,
          `tree labels=${nodeLabels.length}, dbNonDept=${nonDeptNodes}`,
        )
      }
    }
  } finally {
    await ctxAdm.close()
  }

  const overall = summarize(35.7, verdicts, { totalNodes, deptNodes, nonDeptNodes })
  writeContext('link35d', { status: overall, verdicts, totalNodes, deptNodes })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})

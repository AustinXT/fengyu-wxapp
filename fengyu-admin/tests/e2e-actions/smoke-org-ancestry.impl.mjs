/**
 * `src/lib/org-ancestry.ts` 四条递归 CTE 的真库语义冒烟（实现体，由 wrapper 引导）。
 *
 * 断言的是**生产代码里那一份 SQL**（直接 import 那几个函数），不抄副本 ——
 * 抄本会各自漂移，那就退化成「守护一个假的」。
 */
import postgres from 'postgres'
import {
  findNearestStoreAncestor,
  findRolesBoundWithinSubtree,
  findSubtreeOwnershipConflicts,
  isNodeWithinScopeRoots,
} from '@/lib/org-ancestry'

const CONN = process.env.E2E_DATABASE_URL
if (!CONN) throw new Error('缺 E2E_DATABASE_URL')
/**
 * **只准跑一次性库**。夹具要在 `org_nodes` 上造一个自成环的节点，而该表挂着
 * `inventory_sync_location_from_org_node` trigger（库存主体必须与组织树映射一致）——
 * 收场时把 `parent_id` 置 NULL 断环会被它拒掉（P0001），也就是说夹具**清不干净**。
 * 一次性库每跑一次就 DROP + 从模板重建，本来不需要清理；换成共享库就会留下永久残留。
 */
if (!/127\.0\.0\.1:54397\/fengyu_org_ancestry_e2e$/.test(CONN)) {
  throw new Error(`[org-ancestry] 只能跑一次性库 fengyu_org_ancestry_e2e，收到：${CONN}`)
}

const sql = postgres(CONN, { max: 1 })
const NS = 'TE2ANC'
const id = (s) => `${NS}_${s}`

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) console.log(`   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(actual)}`)
}

async function seed() {
  /**
   * 拓扑（两条链刻意做成**镜像**：同一组节点名分挂两个门店，
   * 上溯方向写反时会稳定地取到「另一条链」的门店，而不是碰巧仍对）：
   *
   *   总部 HQ
   *   └── 市场 MKT
   *       ├── 门店 STORE_A ── 部门 DEPT_A ── 部门 SUB_A     （三层：验「最近」与「任意深度」）
   *       ├── 门店 STORE_B ── 部门 DEPT_B
   *       └── 部门 MKT_DEPT                                 （挂市场下 → 无门店祖先）
   *
   *   另有自成环的 LOOP_X ⇄ LOOP_Y，验 path 防环（不防环时递归 CTE 会打满连接）
   */
  await sql`
    INSERT INTO org_nodes (id, name, type, parent_id) VALUES
      (${id('HQ')},       '冒烟总部', '总部', NULL),
      (${id('MKT')},      '冒烟市场', '市场', ${id('HQ')}),
      (${id('STORE_A')},  '冒烟A店',  '门店', ${id('MKT')}),
      (${id('DEPT_A')},   '冒烟A部',  '部门', ${id('STORE_A')}),
      (${id('SUB_A')},    '冒烟A小组','部门', ${id('DEPT_A')}),
      (${id('STORE_B')},  '冒烟B店',  '门店', ${id('MKT')}),
      (${id('DEPT_B')},   '冒烟B部',  '部门', ${id('STORE_B')}),
      (${id('MKT_DEPT')}, '冒烟市场部','部门', ${id('MKT')})
  `
  // 环：先各自挂到 HQ 通过 FK，再互指成环
  await sql`
    INSERT INTO org_nodes (id, name, type, parent_id) VALUES
      (${id('LOOP_X')}, '冒烟环X', '部门', ${id('HQ')}),
      (${id('LOOP_Y')}, '冒烟环Y', '部门', ${id('LOOP_X')})
  `
  await sql`UPDATE org_nodes SET parent_id = ${id('LOOP_Y')} WHERE id = ${id('LOOP_X')}`

  await sql`INSERT INTO staff_wechat_users (employee_id, name) VALUES (${id('EMP')}, '冒烟员工')`
  await sql`INSERT INTO staff_wechat_users (employee_id, name) VALUES (${id('OTHER')}, '冒烟别人')`
  /**
   * ⚠️ 绑定**只能**挂 总部/市场/门店 型节点 —— DB trigger
   * `permission_validate_role_assignment_scope()` 按 `permission_role_definitions.allowed_scope_types`
   * 强制，而现有 10 个角色没有一个含「部门」。所以「绑定挂在门店的下属部门上」这个形态
   * 在库里造不出来（试过，直接 P0001）。子树查询覆盖这种形态是**防御性冗余**而非在修真实缺陷，
   * 详见 `src/lib/org-ancestry.ts` 里那段说明。
   *
   * 这里用可达的形态验证下探语义：市场下挂两个门店，各自有绑定。
   *
   * OTHER 刻意与 EMP 在同一节点上绑**不同**角色（product 而非 manager）。第一版两人都给
   * manager，于是「删掉 employee_id 过滤」这个退化**没让红检变红** ——
   * SELECT DISTINCT role 把两个人的同名角色合成一条，两边答案一模一样。
   * 别人的角色必须与本人不同，过滤失效才会当场露出来。
   */
  await sql`
    INSERT INTO permission_roles (employee_id, role, scope_id) VALUES
      (${id('EMP')},   'manager', ${id('STORE_A')}),
      (${id('EMP')},   'finance', ${id('MKT')}),
      (${id('EMP')},   'hr',      ${id('STORE_B')}),
      (${id('OTHER')}, 'product', ${id('STORE_A')})
  `

  await seedOwnership()
}

/**
 * `findSubtreeOwnershipConflicts` 的夹具（#318）—— 复用上面那棵树，补 `stores` 映射与带
 * `store_id` 的员工。命名一律 `OWN_*`，与上面两个函数的员工（EMP / OTHER，无 store_id）隔开。
 *
 * 门店节点 ↔ stores 一一映射：STORE_A ↔ SA、STORE_B ↔ SB。冲突 = 「员工 org 节点的最近门店
 * 祖先」≠「员工 store_id 对应门店的 org 节点」。
 */
async function seedOwnership() {
  await sql`
    INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed) VALUES
      (${id('SA')}, '冒烟A店门店', ${id('STORE_A')}, CURRENT_DATE, false),
      (${id('SB')}, '冒烟B店门店', ${id('STORE_B')}, CURRENT_DATE, false)
  `
  /**
   * ⚠️ 试过造「`stores.org_node_id IS NULL`」来验 `IS DISTINCT FROM`（换成 `!=` 会 fail-open），
   * 但那个状态**库里造不出来**：trigger `inventory_sync_location_from_store()`
   * （`db/migrations/0009` 第 556 行）对 NULL 直接 `RAISE`，要求必须指向市场下的门店型节点。
   * 生产 43/43 也确实全有映射。所以这里不为它写夹具 —— 守护一个 DB 造不出的状态是虚假保障。
   * `IS DISTINCT FROM` 仍然保留（防御性，见 `src/lib/org-ancestry.ts` 里的说明）。
   */
  await sql`
    INSERT INTO staff_wechat_users (employee_id, name, store_id, org_node_id, is_resigned) VALUES
      (${id('OWN_OK_A')},     '冒烟自洽A',   ${id('SA')}, ${id('DEPT_A')},   false),
      (${id('OWN_BAD_A')},    '冒烟错挂A',   ${id('SB')}, ${id('DEPT_A')},   false),
      (${id('OWN_DEEP')},     '冒烟深层错挂', ${id('SB')}, ${id('SUB_A')},    false),
      (${id('OWN_NOSTORE')},  '冒烟无主店',   NULL,        ${id('DEPT_A')},   false),
      (${id('OWN_RESIGNED')}, '冒烟已离职',   ${id('SB')}, ${id('DEPT_A')},   true),
      (${id('OWN_MKT')},      '冒烟市场部人', ${id('SA')}, ${id('MKT_DEPT')}, false),
      (${id('OWN_OK_B')},     '冒烟自洽B',   ${id('SB')}, ${id('DEPT_B')},   false),
      (${id('OWN_LOOP')},     '冒烟环里人',   ${id('SA')}, ${id('LOOP_Y')},   false)
  `
}

async function main() {
  await seed()

  // ── findNearestStoreAncestor ──────────────────────────────────────────────
  check('门店节点自身 → 返回自身（depth=0 也算）',
    await findNearestStoreAncestor(id('STORE_A')),
    { exists: true, storeAncestorId: id('STORE_A') })

  check('门店下一层部门 → 上溯到该门店',
    await findNearestStoreAncestor(id('DEPT_A')),
    { exists: true, storeAncestorId: id('STORE_A') })

  /**
   * 三层的这条最要紧：把 `JOIN chain c ON o.id = c.parent_id` 写反成 `o.parent_id = c.id`
   * 就变成下探子树，此时从 SUB_A 出发一个门店都遇不到 → `storeAncestorId: null` → 变红。
   * 而 `WITH RECURSIVE` / `UNION ALL` 等关键词一个不少，纯文本断言抓不到这种。
   */
  check('门店下两层部门 → 仍上溯到该门店（任意深度）',
    await findNearestStoreAncestor(id('SUB_A')),
    { exists: true, storeAncestorId: id('STORE_A') })

  check('镜像链的同名层 → 取到自己那条链的门店，不串到另一条',
    await findNearestStoreAncestor(id('DEPT_B')),
    { exists: true, storeAncestorId: id('STORE_B') })

  /**
   * 「最近」而不是「任意」：`ORDER BY depth LIMIT 1` 被删或写成 `DESC` 时，
   * 从 SUB_A 上溯遇到的门店只有一个，抓不出来 —— 所以这里换个角度，
   * 让门店节点自身也在链上（STORE_A 既是 depth=0 又是 DEPT_A 的祖先），
   * 从 STORE_A 出发时唯一正确答案是自身。上面第 1 条已覆盖。
   * 这里补的是「上溯不会越过门店继续拿更高层的门店」—— 本树里市场之上没有门店，
   * 所以改用「市场直属部门」验证反向：够不到门店就必须是 null，不能兜到别处。
   */
  check('市场直属部门 → 无门店祖先（合法的矩阵式归属）',
    await findNearestStoreAncestor(id('MKT_DEPT')),
    { exists: true, storeAncestorId: null })

  check('总部节点 → 无门店祖先',
    await findNearestStoreAncestor(id('HQ')),
    { exists: true, storeAncestorId: null })

  check('节点不存在 → exists:false（与「无门店祖先」必须分开）',
    await findNearestStoreAncestor(id('NOT_THERE')),
    { exists: false })

  /** 防环：`WHERE NOT o.id = ANY(c.path)` 删掉时这一条会挂起/报错而不是返回 */
  const loop = await Promise.race([
    findNearestStoreAncestor(id('LOOP_X')),
    new Promise((_, rej) => setTimeout(() => rej(new Error('环检测超时 —— path 防环没生效')), 8000)),
  ])
  check('自成环的节点 → 正常返回而不是打满连接', loop, { exists: true, storeAncestorId: null })

  // ── findRolesBoundWithinSubtree ───────────────────────────────────────────
  /**
   * §AFF-03 的真实调用形态：根是 `stores.org_node_id`，生产上 43/43 都是门店型节点、
   * 且门店节点下**零子节点** —— 所以这一条同时也是「退化成精确匹配也仍然对」的那个场景。
   * 它锁的是 employee 过滤与去重，不是子树。
   */
  check('门店节点为根 → 捞到挂在它上面的绑定',
    await findRolesBoundWithinSubtree(id('EMP'), id('STORE_A')),
    ['manager'])

  check('另一个门店为根 → 只捞到那条链上的绑定，不串链',
    await findRolesBoundWithinSubtree(id('EMP'), id('STORE_B')),
    ['hr'])

  /**
   * 这一条才真正锁子树的下探方向：把 `JOIN subtree s ON o.parent_id = s.id` 写反成
   * `o.id = s.parent_id` 就变成上溯，从 MKT 出发只会拿到 HQ（无绑定）→ 只剩 `finance` → 变红。
   * 退化成 `scope_id = $1` 精确匹配同样只剩 `finance` → 变红。
   */
  check('市场为根 → 覆盖其下两个门店的绑定（下探方向，与上溯相反）',
    (await findRolesBoundWithinSubtree(id('EMP'), id('MKT'))).sort(),
    ['finance', 'hr', 'manager'])

  /** employee_id 过滤：漏掉它会把别人的绑定也算进提示里（两个方向都验） */
  check('只算该员工的绑定，不含同节点上别人的（本人视角）',
    await findRolesBoundWithinSubtree(id('EMP'), id('STORE_A')),
    ['manager'])
  check('只算该员工的绑定，不含同节点上别人的（他人视角）',
    await findRolesBoundWithinSubtree(id('OTHER'), id('STORE_A')),
    ['product'])

  check('子树内无绑定 → 空数组',
    await findRolesBoundWithinSubtree(id('EMP'), id('MKT_DEPT')),
    [])

  /** 去重：DISTINCT 掉了的话，同一 role 绑在父子两级会重复出现在提示里 */
  await sql`INSERT INTO permission_roles (employee_id, role, scope_id) VALUES (${id('EMP')}, 'manager', ${id('STORE_B')})`
  check('同一角色绑在子树内多个节点 → 去重后只出现一次',
    (await findRolesBoundWithinSubtree(id('EMP'), id('MKT'))).sort(),
    ['finance', 'hr', 'manager'])

  // ── findSubtreeOwnershipConflicts（#318）─────────────────────────────────
  /** 只取 employee_id 的短名，读断言时一眼看出是谁；全字段形状由下面第一条单独锁 */
  const who = (res) => res.conflicts.map((r) => r.employeeId.replace(`${NS}_OWN_`, ''))

  /**
   * 全字段形状锁这一条就够：`name` 是 `updateOrgNode` 拼给用户的那串姓名，
   * 列名映射（`employee_id` → `employeeId`）写错时这里当场露出来。
   */
  check('门店节点为根 → 报出子树内所有归属不自洽的员工（含全字段形状）',
    await findSubtreeOwnershipConflicts(id('STORE_A')),
    {
      conflicts: [
        { employeeId: id('OWN_BAD_A'), name: '冒烟错挂A', storeId: id('SB') },
        { employeeId: id('OWN_DEEP'), name: '冒烟深层错挂', storeId: id('SB') },
      ],
      total: 2,
    })

  /**
   * 三处语义同时锁在这一条的「没出现」里：
   * - `OWN_OK_A`（DEPT_A + SA，自洽）—— 删掉 `nearest` 的 `type = '门店'` 过滤，
   *   store_ancestor 就成了员工自己那个部门节点（DEPT_A ≠ STORE_A）→ 它会被误报 → 变红
   * - `OWN_DEEP` 出现在结果里 —— 锁「任意深度」：只查一层就漏掉 SUB_A 上的人
   * - `OWN_RESIGNED`（DEPT_A + SB，已离职）—— 删掉 `is_resigned = false` 会把它算进来 → 变红
   */
  check('自洽的人与已离职的人都不在结果里',
    who(await findSubtreeOwnershipConflicts(id('STORE_A'))),
    ['BAD_A', 'DEEP'])

  /**
   * 下探方向（与 `findNearestStoreAncestor` 的上溯相反）。把
   * `JOIN subtree s ON o.parent_id = s.id` 写反成 `o.id = s.parent_id` 就变成上溯：
   * 从 STORE_A 出发只会拿到 MKT / HQ，那两个节点上没有员工 → 结果空 → 上面两条同时变红。
   * 这里从市场出发再验一次「跨两个门店子树一起复核」。
   */
  check('市场为根 → 覆盖其下两个门店子树（自洽的 B 店员工不算冲突）',
    who(await findSubtreeOwnershipConflicts(id('MKT'))),
    ['BAD_A', 'DEEP'])

  check('另一个门店为根 → 空（该子树内只有自洽的人，也不串到 A 店那条链）',
    await findSubtreeOwnershipConflicts(id('STORE_B')),
    { conflicts: [], total: 0 })

  /**
   * 无门店祖先 = 合法的矩阵式归属（生产 74 人挂在部门型节点上）。
   * `nearest` 拿不到 `type='门店'` 的行 → 该员工整条不参与比对，必须放行。
   */
  check('市场直属部门为根 → 空（挂在那儿的人没有门店祖先，不构成冲突）',
    await findSubtreeOwnershipConflicts(id('MKT_DEPT')),
    { conflicts: [], total: 0 })

  /**
   * ## 「改挂**出**门店子树」这个方向刻意放行（GLM 第 4 轮 P1 的正面回答）
   *
   * 上一条是「根是市场直属部门」，这一条把它做成真正的**改挂后形态**：
   * 把 A 店下的部门 DEPT_A 改挂到市场下 → 挂 DEPT_A 的员工（store_id 仍指 SA）
   * 最近门店祖先从 A 店变成 NULL。判据必须与员工侧一致 ——
   * `assertOwnershipConsistent` 对 `storeAncestorId === null` 是直接放行的。
   * 改完把树复原，后面的断言仍按原拓扑。
   */
  check('改挂前：A 店子树里这两人是冲突（对照组）',
    who(await findSubtreeOwnershipConflicts(id('MKT'))),
    ['BAD_A', 'DEEP'])
  await sql`UPDATE org_nodes SET parent_id = ${id('MKT')} WHERE id = ${id('DEPT_A')}`
  /**
   * 改挂后 DEPT_A 及其子节点 SUB_A 都脱离了门店子树 → 挂在它们上面的三个人
   * （OWN_OK_A / OWN_BAD_A / OWN_DEEP）最近门店祖先全变成 NULL → 一个都不报。
   * 连原本**是**冲突的 BAD_A 也不再是 —— 这正是「放行 null 分支」的完整后果，
   * 与员工侧 `assertOwnershipConsistent` 对 `storeAncestorId === null` 直接放行一致。
   */
  check('改挂出门店子树（最近门店祖先变 NULL）→ 一个都不报（与员工侧同口径）',
    who(await findSubtreeOwnershipConflicts(id('MKT'))),
    [])
  await sql`UPDATE org_nodes SET parent_id = ${id('STORE_A')} WHERE id = ${id('DEPT_A')}`
  check('复原后对照组回来（确认上一条不是夹具被永久改坏）',
    who(await findSubtreeOwnershipConflicts(id('MKT'))),
    ['BAD_A', 'DEEP'])

  /**
   * `store_id IS NULL`（半填状态）—— 甲方 2026-09-23 拍板 **#259 选项 A：保持放行**。
   * ⚠️ 这一条**不是红检守护**：`JOIN stores ON st.store_id = n.store_id` 是内连接，
   * store_id 为空的行本来就连不上、会被丢掉，所以把 `AND e.store_id IS NOT NULL` 删掉
   * 结果**照样**是空 —— 两种写法在这个前提下恒等。留它是把「A 口径」这个决定钉在真库上：
   * 哪天有人把内连接改成 `LEFT JOIN`（想报出「门店没映射」那类），这条会立刻变红，
   * 提醒他先回去看 #259 的拍板。
   */
  check('半填（store_id 为空、org 在门店子树里）→ 不报（#259 选项 A）',
    who(await findSubtreeOwnershipConflicts(id('DEPT_A'))).includes('NOSTORE'),
    false)

  check('根节点不存在 → 空（而不是报全库）',
    await findSubtreeOwnershipConflicts(id('NOT_THERE')),
    { conflicts: [], total: 0 })

  /**
   * LIMIT 透传：提示只列前几个人，穿参写死成常量或漏掉 `LIMIT` 时这里变红。
   * `total` 必须是**截断前**的总数（窗口函数在 LIMIT 之前求值）—— 否则提示里的
   * 「共 N 人」会退化成「共 1 人」，管理员以为改完一个就完事了。
   */
  {
    const truncated = await findSubtreeOwnershipConflicts(id('HQ'), undefined, 1)
    check('limit 生效 → 只取前 N 个（按 employee_id 排序，结果稳定）',
      who(truncated), ['BAD_A'])
    check('total 是截断前的总数（count(*) OVER () 在 LIMIT 之前求值）',
      truncated.total, 2)
    check('total 是 number 而不是 int8 原样返回的 string',
      typeof truncated.total, 'number')
  }

  /** 防环：subtree 与 chain 两条递归各有一份 path 防环，删任一条这里挂起而不是返回 */
  const loopConflicts = await Promise.race([
    findSubtreeOwnershipConflicts(id('LOOP_X')),
    new Promise((_, rej) => setTimeout(() => rej(new Error('环检测超时 —— path 防环没生效')), 8000)),
  ])
  check('自成环的子树 → 正常返回而不是打满连接', loopConflicts, { conflicts: [], total: 0 })

  // ── isNodeWithinScopeRoots（#318 第 3 轮）────────────────────────────────
  /**
   * 「这个节点现在还在我的管辖范围内吗」—— 按**当前树**判，而不是按 session 里那份
   * 构造时展开好的集合（后者与现在的树无关，锁内再判一次是 no-op）。
   */
  check('根就是自己 → 在范围内（depth=0 也算）',
    await isNodeWithinScopeRoots(id('STORE_A'), [id('STORE_A')]), true)

  check('根是祖先（任意深度）→ 在范围内',
    await isNodeWithinScopeRoots(id('SUB_A'), [id('MKT')]), true)

  /**
   * 这条锁**上溯方向**：把 `JOIN org_nodes p ON p.id = c.parent_id` 写反成
   * `p.parent_id = c.id` 就变成下探，从 SUB_A 出发永远遇不到 MKT → 上一条变红；
   * 而从 MKT 出发能下探到 SUB_A → 这一条会**误判为 true** → 也变红。两条一起把方向钉死。
   */
  check('根是后代 → 不在范围内（方向不能反）',
    await isNodeWithinScopeRoots(id('MKT'), [id('SUB_A')]), false)

  check('另一条链上的根 → 不在范围内（不串链）',
    await isNodeWithinScopeRoots(id('DEPT_A'), [id('STORE_B')]), false)

  check('多个根命中任意一个即可',
    await isNodeWithinScopeRoots(id('DEPT_B'), [id('STORE_A'), id('STORE_B')]), true)

  check('根清单为空 → false（没有管辖根的非 admin 不该改任何节点）',
    await isNodeWithinScopeRoots(id('DEPT_A'), []), false)

  check('节点不存在 → false',
    await isNodeWithinScopeRoots(id('NOT_THERE'), [id('HQ')]), false)

  /** 防环：环里的节点上溯时不能打满连接 */
  const loopScope = await Promise.race([
    isNodeWithinScopeRoots(id('LOOP_Y'), [id('MKT')]),
    new Promise((_, rej) => setTimeout(() => rej(new Error('环检测超时 —— path 防环没生效')), 8000)),
  ])
  check('自成环的节点上溯 → 正常返回而不是打满连接', loopScope, false)

  // 不清理：一次性库下一跑就整库重建（见顶部对环夹具与 trigger 的说明）
  await sql.end()
  console.log(failed === 0 ? '\norg-ancestry 冒烟全部通过' : `\norg-ancestry 冒烟 ${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  try { await sql.end() } catch {}
  process.exit(1)
})

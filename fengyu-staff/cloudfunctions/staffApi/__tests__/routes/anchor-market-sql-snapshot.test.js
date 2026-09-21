/**
 * 员工「锚定市场」SQL 跨端一致性守护（issue #210）
 *
 * 用户已 veto cloudfunctions-shared，各端保留独立副本，一致性靠本测试守护：
 * 任一端的锚定市场推导漂移，「按市场聚合/过滤员工」的口径就会在端之间打架
 * （直挂市场/部门节点的员工——各市场养生部、品项公司——会在某一端凭空消失）。
 *
 * 守护对象：
 *   A. 锚定市场 CASE 表达式 — 五处字节同义
 *      ├── staffApi/utils/employee-assignment.js  (EMPLOYEE_ANCHOR_MARKET_JOIN，服务单候选与校验)
 *      ├── staffApi/routes/allocation.js          (营业额分配候选，内联)
 *      ├── staffApi/routes/serviceCommission.js   (服务提成候选，内联)
 *      ├── fengyu-admin/src/lib/employee-anchor-market-sql.ts (admin 单源)
 *      └── fengyu-admin/src/actions/employees.ts  (getAllocationEmployeeCandidates，内联)
 *
 *   B. 服务指派技能白名单 — 三份副本同序
 *      ├── staffApi/utils/employee-assignment.js
 *      ├── fengyu-admin/src/lib/service-staff-skills.ts
 *      └── miniprogram/packageService/service-create/service-create.ts（SERVICE_ROLES）
 *
 *   C. 服务单候选/校验的触发点 — 两端必须用 marketSupport + 四项白名单，
 *      且开单 / 顾客端口径不得被波及
 *
 * 归一化策略：别名差异（staff 用 so / admin 用 store_node）归一为 <STORE_NODE>，
 * 连续空白压缩为单空格 —— 两端别名各自与本端既有副本保持一致，不强行统一命名，
 * 因此守护的是**语义同义**而非字节同义。
 */

const fs = require('fs')
const path = require('path')

const STAFF_API = path.resolve(__dirname, '../..')
const REPO = path.resolve(STAFF_API, '../../..')
const ADMIN = path.join(REPO, 'fengyu-admin')

const FILES = {
  staffAssignmentUtil: path.join(STAFF_API, 'utils/employee-assignment.js'),
  staffAllocation: path.join(STAFF_API, 'routes/allocation.js'),
  staffServiceCommission: path.join(STAFF_API, 'routes/serviceCommission.js'),
  staffStaffRoute: path.join(STAFF_API, 'routes/staff.js'),
  staffServiceRoute: path.join(STAFF_API, 'routes/service.js'),
  staffServiceCreatePage: path.resolve(
    STAFF_API,
    '../../miniprogram/packageService/service-create/service-create.ts',
  ),
  adminAnchorLib: path.join(ADMIN, 'src/lib/employee-anchor-market-sql.ts'),
  adminSkills: path.join(ADMIN, 'src/lib/service-staff-skills.ts'),
  adminEmployees: path.join(ADMIN, 'src/actions/employees.ts'),
  adminServices: path.join(ADMIN, 'src/actions/services.ts'),
  adminAssignmentServer: path.join(ADMIN, 'src/lib/employee-assignment-server.ts'),
}

const read = (p) => fs.readFileSync(p, 'utf-8')

/**
 * 抽出锚定市场的 COALESCE(...) 表达式并归一化别名与空白。
 * 锚在 `COALESCE(<门店节点别名>.parent_id,` 上，避免匹配到文件里更早出现的
 * 其它 COALESCE（如 allocation.js 的 `COALESCE(c.name, ...)`）。
 */
function extractAnchorExpr(source) {
  const match = source.match(/COALESCE\(\s*(?:so|store_node)\.parent_id,[\s\S]*?ELSE NULL\s*END\s*\)/)
  if (!match) return null
  return match[0]
    .replace(/\bso\.parent_id/g, '<STORE_NODE>.parent_id')
    .replace(/\bstore_node\.parent_id/g, '<STORE_NODE>.parent_id')
    .replace(/\s+/g, ' ')
    .trim()
}

const ANCHOR_SOURCES = [
  { name: 'staffApi/utils/employee-assignment.js', file: FILES.staffAssignmentUtil },
  { name: 'staffApi/routes/allocation.js', file: FILES.staffAllocation },
  { name: 'staffApi/routes/serviceCommission.js', file: FILES.staffServiceCommission },
  { name: 'admin/src/lib/employee-anchor-market-sql.ts', file: FILES.adminAnchorLib },
  { name: 'admin/src/actions/employees.ts', file: FILES.adminEmployees },
]

describe('A. 锚定市场 CASE 表达式五端字节同义', () => {
  test.each(ANCHOR_SOURCES)('$name 含可解析的锚定市场表达式', ({ file }) => {
    expect(extractAnchorExpr(read(file))).toBeTruthy()
  })

  test('五端归一化后完全一致（漂移即提示同步其余四端）', () => {
    const exprs = ANCHOR_SOURCES.map(({ name, file }) => ({ name, expr: extractAnchorExpr(read(file)) }))
    const reference = exprs[0]
    for (const item of exprs.slice(1)) {
      expect(item.expr, `${item.name} 与 ${reference.name} 的锚定市场表达式漂移`).toBe(reference.expr)
    }
  })

  test('五端均按 type = \'市场\' 收口锚定节点', () => {
    for (const { name, file } of ANCHOR_SOURCES) {
      expect(read(file), name).toMatch(/employee_market\.type = '市场'/)
    }
  })

  test('目标门店市场 JOIN 全程 LEFT（门店未挂组织节点时不得把本店员工一并判非法）', () => {
    for (const { name, file } of [
      { name: 'staffApi/utils/employee-assignment.js', file: FILES.staffAssignmentUtil },
      { name: 'admin/src/lib/employee-anchor-market-sql.ts', file: FILES.adminAnchorLib },
    ]) {
      const src = read(file)
      expect(src, name).toMatch(/LEFT JOIN stores target_store ON target_store\.store_id = /)
      expect(src, name).toMatch(/LEFT JOIN org_nodes target_store_node ON target_store_node\.id = target_store\.org_node_id/)
      expect(src, `${name} 不得退回 INNER JOIN`).not.toMatch(/\n\s+JOIN stores target_store/)
    }
  })

  test('marketSupport 条件两端同义（含 employee_market.id IS NOT NULL 防 NULL 误放行）', () => {
    const normalize = (src) => {
      const m = src.match(/\(u\.store_id = [^\n]*is_on_business_trip = true[\s\S]*?target_market\.id\)\)/)
      return m ? m[0].replace(/\$\{?\w+\}?|\$\d/g, '?').replace(/\s+/g, ' ').trim() : null
    }
    const staffCond = normalize(read(FILES.staffAssignmentUtil))
    const adminCond = normalize(read(FILES.adminAnchorLib))
    expect(staffCond).toBeTruthy()
    expect(adminCond, 'admin 与 staff 的 marketSupport 条件漂移').toBe(staffCond)
    expect(staffCond).toContain('employee_market.id IS NOT NULL')
  })

  test('Snapshot 守护（任一字符漂移即可见）', () => {
    expect(extractAnchorExpr(read(FILES.staffAssignmentUtil))).toMatchInlineSnapshot(
      `"COALESCE( <STORE_NODE>.parent_id, CASE WHEN d.type = '市场' THEN d.id WHEN d.type = '门店' THEN d.parent_id WHEN d.type = '部门' AND employee_org_parent.type = '市场' THEN employee_org_parent.id WHEN d.type = '部门' AND employee_org_parent.type = '门店' THEN employee_org_parent.parent_id ELSE NULL END )"`,
    )
  })
})

describe('B. 服务指派技能白名单两端同序', () => {
  /** 从源码里取指定常量的字符串数组字面量 */
  function extractSkillList(source, constName) {
    const match = source.match(new RegExp(`${constName}\\s*=\\s*\\[([^\\]]*)\\]`))
    if (!match) return null
    return match[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }

  const staffSrc = () => read(FILES.staffAssignmentUtil)
  const adminSrc = () => read(FILES.adminSkills)

  test('SERVICE_ORDER_ASSIGNABLE_SKILLS 三份副本同序四项（含小程序 SERVICE_ROLES）', () => {
    const expected = ['店经理', '美容师', '养生师', '品项老师']
    expect(extractSkillList(staffSrc(), 'SERVICE_ORDER_ASSIGNABLE_SKILLS')).toEqual(expected)
    expect(extractSkillList(adminSrc(), 'SERVICE_ORDER_ASSIGNABLE_SKILLS')).toEqual(expected)
    // 小程序端用于派生角色标签，顺序须与后端排序一致，否则标签与列表次序讲不通
    expect(extractSkillList(read(FILES.staffServiceCreatePage), 'SERVICE_ROLES')).toEqual(expected)
  })

  test('DEFAULT_ASSIGNABLE_SKILLS 两端同序两项（开单口径不受服务单放宽影响）', () => {
    const expected = ['美容师', '养生师']
    expect(extractSkillList(staffSrc(), 'DEFAULT_ASSIGNABLE_SKILLS')).toEqual(expected)
    expect(extractSkillList(adminSrc(), 'DEFAULT_ASSIGNABLE_SKILLS')).toEqual(expected)
  })

  test('staff.list 默认分支的内联字面量与 DEFAULT_ASSIGNABLE_SKILLS 一致', () => {
    // 默认分支 SQL 字面刻意不动（被开单/顾客列表/顾客详情/员工绩效 4 个页面复用），
    // 因此无法复用常量；用守护断言两者不漂移。
    const inline = read(FILES.staffStaffRoute).match(/u\.skills && ARRAY\[([^\]]*)\]::text\[\]/)
    expect(inline).toBeTruthy()
    const parsed = inline[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
    expect(parsed).toEqual(extractSkillList(staffSrc(), 'DEFAULT_ASSIGNABLE_SKILLS'))
  })

  test('白名单顺序即排序优先级：两端候选查询均用 array_position 取最小序', () => {
    expect(read(FILES.staffStaffRoute)).toMatch(/array_position\(\$2::text\[\], sk\)/)
    expect(read(FILES.adminEmployees)).toMatch(/array_position\(\$\{sql\.param\(skills\)\}::text\[\], sk\)/)
  })
})

describe('C. 服务单创建两端均走 marketSupport + 四项白名单', () => {
  test('staff service.create 校验用 marketSupport', () => {
    const src = read(FILES.staffServiceRoute)
    expect(src).toMatch(/assignmentScope: 'marketSupport'/)
    expect(src).toMatch(/skills: SERVICE_ORDER_ASSIGNABLE_SKILLS/)
  })

  test('admin createServiceOrder 校验用 marketSupport', () => {
    const src = read(FILES.adminServices)
    expect(src).toMatch(/assignmentScope: 'marketSupport'/)
    expect(src).toMatch(/skills: SERVICE_ORDER_ASSIGNABLE_SKILLS/)
  })

  test('service 场景仅店长放宽（普通员工只能把服务单指派给自己，无需全市场候选）', () => {
    expect(read(FILES.staffStaffRoute))
      .toMatch(/scene === 'service' && isCurrentStoreManager\(ctx\.auth\)/)
  })

  test('两端角色标签均按白名单顺序拼接（不按员工 skills 存储顺序）', () => {
    // skills=['养生师','店经理'] 时若各按各的顺序 join，两端 label 会对不上
    expect(read(FILES.staffServiceCreatePage))
      .toMatch(/SERVICE_ROLES\.filter\(role => \(skills \|\| \[\]\)\.includes\(role\)\)/)
    expect(read(path.join(ADMIN, 'src/lib/service-staff-candidate.ts')))
      .toMatch(/SERVICE_ORDER_ASSIGNABLE_SKILLS\s*\n?\s*\.filter\(\(skill\) => candidate\.skills\?\.includes\(skill\)\)/)
  })

  test('外援标签在两端同义：assignmentScope 缺失时都按「非外援」处理', () => {
    expect(read(FILES.staffServiceCreatePage))
      .toMatch(/staff\.assignmentScope && staff\.assignmentScope !== 'local'/)
    expect(read(path.join(ADMIN, 'src/lib/service-staff-candidate.ts')))
      .toMatch(/candidate\.assignmentScope && candidate\.assignmentScope !== 'local'/)
  })

  test('marketSupport 强制带技能过滤（校验不得比候选宽松）', () => {
    // 候选侧一定按四项白名单筛；校验侧若可被 requireServiceSkills=false 关掉技能过滤，
    // 无服务技能的同市场出差员工就能绕过前端直接提交成功。
    expect(read(FILES.staffAssignmentUtil))
      .toMatch(/assignmentScope === 'marketSupport' \|\| options\.requireServiceSkills === true/)
    expect(read(FILES.adminAssignmentServer))
      .toMatch(/isMarketSupport \|\| options\.requireServiceSkills === true/)
  })

  test('两端 helper 均实现 marketSupport 第三态', () => {
    expect(read(FILES.staffAssignmentUtil)).toMatch(/marketSupport/)
    expect(read(FILES.adminAssignmentServer)).toMatch(/marketSupport/)
  })

  test('开单路径仍是 localOnly + 两项白名单（不得被服务单放宽波及）', () => {
    const staffOrder = read(path.join(STAFF_API, 'routes/order.js'))
    expect(staffOrder).toMatch(/assertEmployeesAssignableToStore\(pg, \[preferredStaffWfId\], storeId, \{ requireServiceSkills: true \}\)/)
    expect(staffOrder).not.toMatch(/marketSupport/)
    // admin 三处 preferredEmployeeId 校验同样不得出现 marketSupport
    const adminOrders = read(path.join(ADMIN, 'src/actions/orders.ts'))
    expect(adminOrders).not.toMatch(/marketSupport/)
  })

  test('顾客端选美容师口径不变（clientApi 仍限本店 + 两项技能）', () => {
    const clientStaff = read(path.join(REPO, 'fengyu-client/cloudfunctions/clientApi/routes/staff.js'))
    expect(clientStaff).toMatch(/ARRAY\['美容师','养生师'\]::text\[\]/)
    expect(clientStaff).not.toMatch(/品项老师|marketSupport/)
  })
})

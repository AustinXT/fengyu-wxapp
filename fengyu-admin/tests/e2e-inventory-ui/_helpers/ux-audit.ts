/**
 * e2e-inventory-ui/_helpers/ux-audit.ts
 *
 * 交互合理性的启发式扫描器。
 *
 * 定位：**发现线索，不做终审**。每条 finding 都带证据（字段名/控件类型/页面路径），
 * 交由人工复核定性为「真问题 / 设计如此 / 误报」。宁可多报也不漏报，
 * 但每条都必须给出可核对的事实，不能只喊"体验不好"。
 */

import type { Locator, Page } from '@playwright/test'

export type Severity = 'P0' | 'P1' | 'P2'

export interface Finding {
  rule: string
  severity: Severity
  page: string
  detail: string
  evidence?: string
}

/**
 * 本应从档案里选、而不是让用户手打的字段。
 *
 * 判据：字段值是一个**已有档案表 / 枚举 / 组织树**的引用。手打会导致
 * 同一实体出现多种写法，且无法与档案表建立关联（SKU 的「供货商」就是活例子：
 * inventory_suppliers 有完整档案，inventory_skus.supplier 却是自由 text，无外键）。
 */
const FOREIGN_KEY_LIKE_LABELS = [
  '供应商', '供货商', '库存主体', '出库主体', '入库主体', '退货主体', '回库主体',
  '库位', '批次', '商品', 'SKU', '员工', '顾客', '市场', '门店', '总部', '方案', '系列',
]

/** 只是描述性文本、不构成外键的字段，排除掉避免误报 */
const FREE_TEXT_EXCEPTIONS = [
  '明细备注', '备注', '原因', '退货原因', '驳回原因', '审批备注', '收货备注',
  '物流公司', '物流单号', '收据附件地址', '覆盖原因', '手工覆盖原因',
  '批号',   // 批号是本次入库新建的标识，不是选已有档案
  '产品系列', '采购分类', '生产厂家', '品牌',  // 自由填写的分类文本
]

/**
 * 数值语义词：命中即不算外键字段。
 *
 * 很多金额字段的名字里天然带着组织/角色词 ——「门店进货价」含「门店」、
 * 「市场员工购价」含「员工」、「顾客零售价」含「顾客」。只按关键词包含匹配
 * 会把这些价格输入框全部误报成"应该做成下拉"，报告一注水，人工复核就不看了。
 */
const NUMERIC_SEMANTIC = ['价', '金额', '货款', '折扣', '优惠', '数量', '比例', '率', '成本']

export interface FormControl {
  label: string
  tag: string
  required: boolean
  labelBound: boolean
}

/** 抽取容器内所有「label 包裹控件」的字段信息 */
export async function extractFormControls(scope: Locator): Promise<FormControl[]> {
  return await scope.locator('label').evaluateAll((labels) =>
    labels.map((label) => {
      const control = label.querySelector('input, select, textarea')
      // sr-only 是只给读屏的补充说明（#135 给必填字段加了「（必填）」），
      // **不能**算进字段名：否则 bare 会以「（必填）」结尾，
      // 规则 1 里靠 `bare.endsWith(ex)` 的白名单豁免会整批失效，凭空冒出一串 P1 误报。
      const holder = label.querySelector('span')
      let labelText: string
      if (holder) {
        const clone = holder.cloneNode(true) as HTMLElement
        clone.querySelectorAll('.sr-only').forEach((el) => el.remove())
        labelText = (clone.textContent ?? '').trim()
      } else {
        labelText = (label.textContent ?? '').trim()
      }
      return {
        label: labelText.split('\n')[0].trim(),
        tag: control ? control.tagName.toLowerCase() : 'none',
        required: control
          ? control.hasAttribute('required') || control.getAttribute('aria-required') === 'true'
          : false,
        labelBound: Boolean(control) || label.hasAttribute('for'),
      }
    }),
  )
}

/** 规则 1：外键类字段却给了自由文本输入 */
export function checkForeignKeyInputs(controls: FormControl[], pageName: string): Finding[] {
  const findings: Finding[] = []
  for (const c of controls) {
    if (c.tag !== 'input' && c.tag !== 'textarea') continue
    const bare = c.label.replace(/\s*\*\s*$/, '').trim()
    if (!bare) continue
    if (FREE_TEXT_EXCEPTIONS.some((ex) => bare === ex || bare.endsWith(ex))) continue
    if (NUMERIC_SEMANTIC.some((kw) => bare.includes(kw))) continue
    const hit = FOREIGN_KEY_LIKE_LABELS.find((kw) => bare.includes(kw))
    if (hit) {
      findings.push({
        rule: '外键类字段应提供选择器',
        severity: 'P1',
        page: pageName,
        detail: `字段「${bare}」引用的是已有档案（命中关键词「${hit}」），却渲染为 <${c.tag}> 自由输入`,
        evidence: `label="${c.label}" control=<${c.tag}>`,
      })
    }
  }
  return findings
}

/** 规则 2：label 与控件未建立关联（屏幕阅读器读不到字段名） */
export function checkLabelBinding(controls: FormControl[], pageName: string): Finding[] {
  const orphan = controls.filter((c) => c.tag === 'none' && c.label && !c.labelBound)
  if (orphan.length === 0) return []
  return [{
    rule: 'label 未与控件关联',
    severity: 'P2',
    page: pageName,
    detail: `${orphan.length} 个 <label> 既未包裹控件也没有 for 属性，辅助技术无法把字段名念给用户`,
    evidence: orphan.slice(0, 5).map((c) => c.label).join(' / '),
  }]
}

/** 规则 3：必填项缺少可见标记 */
export function checkRequiredMarkers(controls: FormControl[], pageName: string): Finding[] {
  const marked = controls.filter((c) => /\*/.test(c.label))
  const withAttr = controls.filter((c) => c.required)
  if (marked.length === 0 && withAttr.length === 0 && controls.length > 3) {
    return [{
      rule: '必填项无标记',
      severity: 'P2',
      page: pageName,
      detail: `表单共 ${controls.length} 个字段，既无 * 标记也无 required/aria-required —— 用户只能靠提交报错试出必填项`,
      evidence: controls.slice(0, 6).map((c) => c.label).join(' / '),
    }]
  }
  return []
}

/** 规则 4：页面文本泄漏技术细节 */
export function checkTechnicalLeak(text: string, pageName: string): Finding[] {
  const patterns: Array<[RegExp, string]> = [
    [/\b42\d{3}\b/, 'PostgreSQL 错误码'],
    [/PERMISSION_DENIED|INVALID_STATE|NOT_FOUND:|CONFLICT:/, '内部错误前缀'],
    [/\bnull\b|\bundefined\b|\bNaN\b/, 'JS 空值'],
    [/An error occurred in the Server Components render/, 'Next.js 脱敏占位文案'],
    [/^\d{9,}$/m, '疑似裸露的 error digest 数字'],
  ]
  const findings: Finding[] = []
  for (const [re, what] of patterns) {
    const m = text.match(re)
    if (m) {
      findings.push({
        rule: '错误信息暴露技术细节',
        severity: 'P1',
        page: pageName,
        detail: `页面出现${what}，用户无法理解也无从处理`,
        evidence: m[0].slice(0, 120),
      })
    }
  }
  return findings
}

/** 规则 5：列表页缺少分页/总数/空态引导 */
export async function checkListAffordances(
  page: Page,
  pageName: string,
  opts: { isReport?: boolean } = {},
): Promise<Finding[]> {
  const findings: Finding[] = []
  const main = (await page.locator('main').innerText().catch(() => '')) || ''
  const rowCount = await page.locator('tbody tr').count().catch(() => 0)

  if (rowCount === 0) {
    const hasEmptyHint = /暂无|没有数据|空空如也|还没有/.test(main)
    if (!hasEmptyHint) {
      findings.push({
        rule: '空态无提示',
        severity: 'P2',
        page: pageName,
        detail: '列表为空且没有任何「暂无数据」类文案，用户分不清是加载失败还是确实没有',
      })
    }
  } else if (!opts.isReport && !/共\s*\d+\s*条|第\s*\d+\s*页|上一页|下一页/.test(main)) {
    // 报表页（如货款结算）按期间汇总，本来就没有分页语义，不参与此规则
    findings.push({
      rule: '列表缺少分页与总数',
      severity: 'P2',
      page: pageName,
      detail: `列表有 ${rowCount} 行数据，但页面没有总数或分页控件，用户不知道数据有没有被截断`,
    })
  }
  return findings
}

/** 规则 6：数量/金额输入缺少边界约束 */
export async function checkNumericGuards(scope: Locator, pageName: string): Promise<Finding[]> {
  const findings: Finding[] = []
  // ⚠️ 必须同时收 type=number：#135 把办理台的数值输入从 inputmode="decimal" 改成了
  // type="number"，只按 inputmode 选的话这条规则会一个元素都匹配不到、
  // 然后「0 个未受保护」静默通过 —— 不是修好了，是检测器瞎了。
  const numeric = scope.locator(
    'input[type="number"], input[inputmode="decimal"], input[placeholder="数量"]',
  )
  const count = await numeric.count()
  let unguarded = 0
  const samples: string[] = []
  for (let i = 0; i < Math.min(count, 6); i += 1) {
    const el = numeric.nth(i)
    const [min, type, ph] = await Promise.all([
      el.getAttribute('min'),
      el.getAttribute('type'),
      el.getAttribute('placeholder'),
    ])
    // 必须 type=number **且** 有 min，缺一不可（#135 收紧）。
    // 原判据是 `type !== 'number' && min === null`，即两者有其一就算过 ——
    // 但 min/max 对 type=text **完全无效**（HTML 规范里只作用于 number/range/date 系），
    // 「给 text 加个 min」能骗过这条规则却零实际效果，正是 issue 字面建议会掉进的假修复。
    if (type !== 'number' || min === null) {
      unguarded += 1
      if (samples.length < 4) samples.push(ph || `第${i + 1}个数值框`)
    }
  }
  if (unguarded > 0) {
    findings.push({
      rule: '数值输入无浏览器级边界约束',
      severity: 'P2',
      page: pageName,
      detail: `${unguarded}/${count} 个数值输入不是 type=number 或缺少 min 属性（min 对 type=text 无效），负数与超大值只能等服务端拒绝`,
      evidence: samples.join(' / '),
    })
  }
  return findings
}

/** 把 findings 渲染成 Markdown 表格 */
export function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return '_本轮扫描未发现问题。_\n'
  const order: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 }
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity])
  const lines = ['| 严重度 | 规则 | 位置 | 说明 | 证据 |', '|---|---|---|---|---|']
  for (const f of sorted) {
    const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
    lines.push(`| ${f.severity} | ${esc(f.rule)} | \`${esc(f.page)}\` | ${esc(f.detail)} | ${f.evidence ? `\`${esc(f.evidence).slice(0, 80)}\`` : '—'} |`)
  }
  return lines.join('\n') + '\n'
}

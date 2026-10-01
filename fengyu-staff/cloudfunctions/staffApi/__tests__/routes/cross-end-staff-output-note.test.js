/**
 * 员工维度数值口径说明的跨端逐字一致（issue #299）。
 *
 * 口径拍板（2026-09-23）：员工排行榜「scope 决定谁上榜、归属决定数字」，金额不按 scope 过滤，
 * 不改 SQL，只补说明；文案定稿「数值为员工个人全域产出」（不用「非本店」）。
 *   - admin 单源常量 `fengyu-admin/src/lib/data-center/staff-output-note.ts` STAFF_OUTPUT_SCOPE_NOTE
 *     （员工排名榜 / 按技师人效的展示由 admin efficiency-board.test.tsx 守护）
 *   - staff `miniprogram/pages/mgmt-dashboard/mgmt-dashboard.wxml` 员工排行榜标题下的 ranking-table-note
 * 任一端改字，本文件变红。
 */

const fs = require('node:fs')
const path = require('node:path')
const { parse: babelParse } = require('@babel/parser')

const ADMIN_NOTE_FILE = path.resolve(
  __dirname,
  '../../../../../fengyu-admin/src/lib/data-center/staff-output-note.ts',
)
const WXML_FILE = path.resolve(
  __dirname,
  '../../../../miniprogram/pages/mgmt-dashboard/mgmt-dashboard.wxml',
)

const EXPECTED = '数值为员工个人全域产出'

/** 用真解析器取 admin 导出常量的字符串值（注释 / 同名字符串不会干扰） */
function readAdminNote() {
  const ast = babelParse(fs.readFileSync(ADMIN_NOTE_FILE, 'utf8'), {
    sourceType: 'module',
    plugins: ['typescript'],
  })
  const values = []
  for (const node of ast.program.body) {
    if (node.type !== 'ExportNamedDeclaration' || !node.declaration) continue
    if (node.declaration.type !== 'VariableDeclaration') continue
    for (const d of node.declaration.declarations) {
      if (d.id.type === 'Identifier' && d.id.name === 'STAFF_OUTPUT_SCOPE_NOTE') {
        if (d.init?.type !== 'StringLiteral') throw new Error('STAFF_OUTPUT_SCOPE_NOTE 必须是字符串字面量')
        values.push(d.init.value)
      }
    }
  }
  return values
}

/** 去掉 WXML 注释（<!-- ... -->），避免注释里的文案冒充实际渲染 */
function readWxmlWithoutComments() {
  return fs.readFileSync(WXML_FILE, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
}

/** 截取 wx:if / wx:elif 某个 activeTab 分支的 <block> 内容（到下一个同级 activeTab 分支为止） */
function tabBlock(wxml, tab) {
  const re = /<block\s+wx:(?:el)?if="\{\{\s*activeTab === '([A-Za-z]+)'\s*\}\}">/g
  const heads = [...wxml.matchAll(re)]
  const i = heads.findIndex((m) => m[1] === tab)
  if (i < 0) throw new Error(`mgmt-dashboard.wxml 找不到 activeTab === '${tab}' 分支`)
  const end = i + 1 < heads.length ? heads[i + 1].index : wxml.length
  return wxml.slice(heads[i].index, end)
}

const NOTE_RE = /<view\s+class="ranking-table-note"\s*>([\s\S]*?)<\/view>/g

describe('员工维度口径说明跨端逐字一致（#299）', () => {
  it('admin 常量恰好一处定义，值为定稿文案', () => {
    expect(readAdminNote()).toEqual([EXPECTED])
  })

  it('staff 员工排行榜标题下紧跟说明，文本与 admin 常量逐字一致', () => {
    const block = tabBlock(readWxmlWithoutComments(), 'staffRanking')
    const notes = [...block.matchAll(NOTE_RE)].map((m) => m[1])
    expect(notes).toEqual(readAdminNote())
    // 位置：标题之后、表头之前，只隔空白
    expect(block).toMatch(
      /<view class="ranking-table-title">员工排行榜<\/view>\s*<view class="ranking-table-note">[^<]*<\/view>\s*<view class="ranking-table-header">/,
    )
  })

  it('说明只出现在员工排行榜：门店排行榜及其余分支都没有', () => {
    const wxml = readWxmlWithoutComments()
    expect(tabBlock(wxml, 'storeRanking')).not.toContain(EXPECTED)
    expect(tabBlock(wxml, 'storeRanking')).not.toContain('ranking-table-note')
    expect(wxml.split(EXPECTED).length - 1).toBe(1)
    expect(wxml.split('ranking-table-note').length - 1).toBe(1)
  })
})

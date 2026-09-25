import { access, mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXPORT_META_SHEET_NAME, writeStreamXlsx, type WorkerExportColumn } from './xlsx-writer'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function* sampleRows() {
  yield { id: 1, name: '第一行' }
  yield { id: 2, name: '第二行' }
  yield { id: 3, name: '第三行' }
}

describe('writeStreamXlsx', () => {
  it('commits rows and starts a new worksheet at the configured boundary', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fengyu-xlsx-test-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'export.xlsx')

    const result = await writeStreamXlsx({
      filePath,
      sheetName: '导出数据',
      rows: sampleRows(),
      rowsPerSheet: 2,
      columns: [
        { header: '编号', value: (row) => row.id },
        { header: '名称', value: (row) => row.name },
      ],
    })

    expect(result).toEqual({ rowCount: 3, sheetCount: 2 })

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['导出数据', '导出数据-2'])
    expect(workbook.worksheets[0].rowCount).toBe(3)
    expect(workbook.worksheets[1].rowCount).toBe(2)
    expect(workbook.worksheets[1].getCell('B2').text).toBe('第三行')
  })

  it('单行表头默认行为不变：只冻结首行、无合并、无额外 sheet', async () => {
    const filePath = await tempFile()
    await writeStreamXlsx({
      filePath,
      sheetName: '订单',
      rows: sampleRows(),
      columns: [
        { header: '编号', value: (row) => row.id },
        { header: '名称', value: (row) => row.name },
      ],
    })
    const workbook = await readBack(filePath)
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['订单'])
    const sheet = workbook.worksheets[0]
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    expect((sheet.views[0] as { xSplit?: number }).xSplit ?? 0).toBe(0)
    expect(sheet.model.merges ?? []).toEqual([])
    expect(sheet.getRow(1).values).toEqual([, '编号', '名称'])
    expect(sheet.getCell('A2').value).toBe(1)
  })

  it('两行合并表头 + 冻结表头行与冻结列 + 小计加粗 + 合计行 + 元信息 sheet', async () => {
    interface Row { store: string; subtotal?: boolean; cells: Record<string, number> }
    const days = ['09-01', '09-02']
    const columns: WorkerExportColumn<Row>[] = [
      { header: '门店', width: 18, value: (row) => row.store },
      ...days.flatMap((day) => (['业绩', '消耗'] as const).map((label) => ({
        header: label,
        group: { key: day, header: day },
        numFmt: '0.00',
        value: (row: Row) => row.cells[`${day}:${label}`],
      }))),
      { header: '合计业绩', value: (row) => row.cells.total, total: 100.5 },
    ]
    columns[1].total = 100.5
    columns[4].total = -5
    async function* rows(): AsyncGenerator<Row> {
      yield { store: '一店', cells: { '09-01:业绩': 100.5, '09-01:消耗': 20, '09-02:业绩': 0, '09-02:消耗': -5, total: 100.5 } }
      yield { store: '南昌小计', subtotal: true, cells: { '09-01:业绩': 100.5, '09-01:消耗': 20, '09-02:业绩': 0, '09-02:消耗': -5, total: 100.5 } }
    }
    const filePath = await tempFile()
    const result = await writeStreamXlsx({
      filePath,
      sheetName: '经营数据主表',
      rows: rows(),
      columns,
      frozenColumns: 1,
      isEmphasisRow: (row) => !!row.subtotal,
      totalsLabel: '合计',
      meta: [
        { label: '时间区间', value: '2026-09-01 ~ 2026-09-30' },
        { label: '导出人', value: '张三' },
      ],
    })
    expect(result).toEqual({ rowCount: 2, sheetCount: 1 })

    const workbook = await readBack(filePath)
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['经营数据主表', EXPORT_META_SHEET_NAME])
    const sheet = workbook.worksheets[0]
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 2, xSplit: 1 })
    expect([...(sheet.model.merges ?? [])].sort()).toEqual(['A1:A2', 'B1:C1', 'D1:E1', 'F1:F2'].sort())
    expect(sheet.getCell('B1').text).toBe('09-01')
    expect(sheet.getCell('D1').text).toBe('09-02')
    expect(['B2', 'C2', 'D2', 'E2'].map((a) => sheet.getCell(a).text)).toEqual(['业绩', '消耗', '业绩', '消耗'])
    expect(sheet.getCell('A1').text).toBe('门店')
    expect(sheet.getCell('F1').text).toBe('合计业绩')
    // 数据从第 3 行开始，金额写原值 + 数字格式
    expect(sheet.getCell('B3').value).toBe(100.5)
    expect(sheet.getCell('B3').numFmt).toBe('0.00')
    expect(sheet.getCell('E3').value).toBe(-5)
    expect(sheet.getCell('A3').font?.bold).toBeFalsy()
    expect(sheet.getCell('A4').font?.bold).toBe(true)
    expect(sheet.getCell('A5').text).toBe('合计')
    expect(sheet.getCell('A5').font?.bold).toBe(true)
    expect(sheet.getCell('B5').value).toBe(100.5)
    expect(sheet.getCell('C5').value ?? '').toBe('') // 没给 total 的列留空，不套数据行取值函数
    expect(sheet.getCell('E5').value).toBe(-5)
    expect(sheet.getCell('F5').value).toBe(100.5)
    expect(sheet.rowCount).toBe(5)

    const meta = workbook.getWorksheet(EXPORT_META_SHEET_NAME)!
    expect(meta.getCell('A1').text).toBe('时间区间')
    expect(meta.getCell('B2').text).toBe('张三')
  })

  it('多行表头（含换行）开自动换行并撑高行；不含换行的表头不加换行样式（#372）', async () => {
    const columns: WorkerExportColumn<{ id: number }>[] = [
      { header: '门店', group: { key: 'blank', header: '' }, value: (row) => row.id },
      { header: '当月\n完成', group: { key: 'sales', header: '销售业绩目标\n第二行\n第三行' }, value: (row) => row.id },
    ]
    async function* rows() { yield { id: 1 } }
    const filePath = await tempFile()
    await writeStreamXlsx({ filePath, sheetName: '主表', rows: rows(), columns })

    const sheet = (await readBack(filePath)).worksheets[0]
    expect(sheet.getCell('B1').text).toBe('销售业绩目标\n第二行\n第三行')
    expect(sheet.getCell('B1').alignment?.wrapText).toBe(true)
    expect(sheet.getCell('B2').alignment?.wrapText).toBe(true)
    expect(sheet.getCell('A2').alignment?.wrapText).toBeFalsy()
    expect(sheet.getRow(1).height).toBe(3 * 15 + 4)
    expect(sheet.getRow(2).height).toBe(2 * 15 + 4)
  })

  it('分 sheet 时每个 sheet 都有两行表头与合并，合计行只在最后一个 sheet', async () => {
    const filePath = await tempFile()
    await writeStreamXlsx({
      filePath,
      sheetName: '频率表',
      rows: sampleRows(),
      rowsPerSheet: 2,
      columns: [
        { header: '编号', value: (row) => row.id },
        { header: '名称', group: { key: 'g', header: '组' }, value: (row) => row.name, total: '共 3 人' },
      ],
      totalsLabel: '合计',
    })
    const workbook = await readBack(filePath)
    const [first, second] = workbook.worksheets
    for (const sheet of [first, second]) {
      expect(sheet.getCell('B1').text).toBe('组')
      expect(sheet.model.merges).toEqual(['A1:A2'])
    }
    expect(first.rowCount).toBe(4)
    expect(second.rowCount).toBe(4) // 2 表头 + 1 数据 + 1 合计
    expect(second.getCell('A4').text).toBe('合计')
    expect(second.getCell('B4').text).toBe('共 3 人')
    expect(first.getCell('A4').text).not.toBe('合计')
  })

  it('没有数据行时不写合计行', async () => {
    const filePath = await tempFile()
    async function* none(): AsyncGenerator<{ id: number; name: string }> {}
    const result = await writeStreamXlsx({
      filePath,
      sheetName: '空',
      rows: none(),
      columns: [{ header: '编号', value: (row) => row.id }],
      totalsLabel: '合计',
    })
    expect(result.rowCount).toBe(0)
    const workbook = await readBack(filePath)
    expect(workbook.worksheets[0].rowCount).toBe(1)
  })
})

describe('writeStreamXlsx · 失败路径与防御', () => {
  it('列定义错误在打开文件之前就抛，不留半个文件', async () => {
    const filePath = await tempFile()
    await expect(writeStreamXlsx({
      filePath,
      sheetName: 'x',
      rows: sampleRows(),
      columns: [
        { header: 'a', group: { key: 'g', header: 'G' }, value: (row) => row.id },
        { header: 'b', value: (row) => row.id },
        { header: 'c', group: { key: 'g', header: 'G' }, value: (row) => row.id },
      ],
    })).rejects.toThrow(/不相邻/)
    await expect(access(filePath)).rejects.toThrow()
  })

  it('取数中途失败：原错误抛出，写流被关闭（长驻 worker 不漏 fd）', async () => {
    const filePath = await tempFile()
    const destroy = vi.spyOn(Writable.prototype, 'destroy')
    async function* broken() {
      yield { id: 1, name: 'a' }
      throw new Error('boom: db gone')
    }
    await expect(writeStreamXlsx({
      filePath,
      sheetName: 'x',
      rows: broken(),
      columns: [{ header: '编号', value: (row) => row.id }],
    })).rejects.toThrow('boom: db gone')
    expect(destroy).toHaveBeenCalled()
    destroy.mockRestore()
  })

  it('数据 sheet 与「导出说明」同名时避让；冻结列数超出列数按列数夹紧', async () => {
    const filePath = await tempFile()
    await writeStreamXlsx({
      filePath,
      sheetName: EXPORT_META_SHEET_NAME,
      rows: sampleRows(),
      frozenColumns: 99,
      columns: [{ header: '编号', value: (row) => row.id }],
      meta: [{ label: '范围', value: '全部' }],
    })
    const workbook = await readBack(filePath)
    const names = workbook.worksheets.map((sheet) => sheet.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([`${EXPORT_META_SHEET_NAME}数据`, EXPORT_META_SHEET_NAME])
    expect((workbook.worksheets[0].views[0] as { xSplit?: number }).xSplit).toBe(1)
  })
})

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fengyu-xlsx-test-'))
  tempDirs.push(dir)
  return path.join(dir, 'export.xlsx')
}

async function readBack(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  return workbook
}

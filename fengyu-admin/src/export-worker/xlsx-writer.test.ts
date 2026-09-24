import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, describe, expect, it } from 'vitest'
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
      { header: '合计业绩', value: (row) => row.cells.total },
    ]
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
      totalsRow: { store: '合计', cells: { '09-01:业绩': 100.5, '09-01:消耗': 20, '09-02:业绩': 0, '09-02:消耗': -5, total: 100.5 } },
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
    expect(sheet.getCell('F5').value).toBe(100.5)
    expect(sheet.rowCount).toBe(5)

    const meta = workbook.getWorksheet(EXPORT_META_SHEET_NAME)!
    expect(meta.getCell('A1').text).toBe('时间区间')
    expect(meta.getCell('B2').text).toBe('张三')
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
        { header: '名称', group: { key: 'g', header: '组' }, value: (row) => row.name },
      ],
      totalsRow: { id: 0, name: '合计' },
    })
    const workbook = await readBack(filePath)
    const [first, second] = workbook.worksheets
    for (const sheet of [first, second]) {
      expect(sheet.getCell('B1').text).toBe('组')
      expect(sheet.model.merges).toEqual(['A1:A2'])
    }
    expect(first.rowCount).toBe(4)
    expect(second.rowCount).toBe(4) // 2 表头 + 1 数据 + 1 合计
    expect(second.getCell('B4').text).toBe('合计')
  })

  it('没有数据行时不写合计行', async () => {
    const filePath = await tempFile()
    async function* none(): AsyncGenerator<{ id: number; name: string }> {}
    const result = await writeStreamXlsx({
      filePath,
      sheetName: '空',
      rows: none(),
      columns: [{ header: '编号', value: (row) => row.id }],
      totalsRow: { id: 0, name: '合计' },
    })
    expect(result.rowCount).toBe(0)
    const workbook = await readBack(filePath)
    expect(workbook.worksheets[0].rowCount).toBe(1)
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

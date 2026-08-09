import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, describe, expect, it } from 'vitest'
import { writeStreamXlsx } from './xlsx-writer'

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
})

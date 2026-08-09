import { describe, expect, it } from 'vitest'
import { exportCloudPath, exportFileName } from './file-name'

describe('导出文件名', () => {
  it('以导出任务名称生成 xlsx 文件名', () => {
    const fileName = exportFileName('营业额分配-销售提成')

    expect(fileName).toBe('营业额分配-销售提成.xlsx')
  })

  it('将生成的文件名用于 CloudBase 对象路径', () => {
    const fileName = '营业额分配-销售提成.xlsx'

    expect(exportCloudPath(42, fileName))
      .toBe('admin/exports/42/营业额分配-销售提成.xlsx')
  })
})

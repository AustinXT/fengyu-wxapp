import { shanghaiYmd } from '@/lib/datetime'

/** 任务中心展示名称既是下载文件的名称来源，也是云存储对象名的一部分。 */
export function exportFileName(label: string, now = new Date()): string {
  const cleaned = label.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim() || '导出数据'
  const timestamp = now.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  }).replace(/:/g, '')
  return `${cleaned}_${shanghaiYmd(now)}${timestamp}.xlsx`
}

/** CloudBase 临时下载 URL 会沿用对象名，不能使用固定的 content.xlsx。 */
export function exportCloudPath(jobId: number, fileName: string): string {
  return `admin/exports/${jobId}/${fileName}`
}

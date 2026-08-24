import { describe, expect, it } from 'vitest'
import { estimateBackupBytes } from './database-backup'

const MIB = 1024 * 1024

describe('database backup capacity estimate', () => {
  it('小数据库至少预留 256 MiB', () => {
    expect(estimateBackupBytes(10 * MIB, 5 * MIB)).toBe(256 * MIB)
  })

  it('按数据库 1.2 倍和上次备份 1.5 倍取较大值', () => {
    expect(estimateBackupBytes(1_000 * MIB, 100 * MIB)).toBe(1_200 * MIB)
    expect(estimateBackupBytes(100 * MIB, 1_000 * MIB)).toBe(1_500 * MIB)
  })
})

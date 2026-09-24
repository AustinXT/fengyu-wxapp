import { readFileSync } from 'node:fs'
import path from 'node:path'
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

/**
 * 2026-09-12 回归：recordBackupOutcome 的 jsonb_build_object 参数未转型时报 42P18
 * 「could not determine data type of parameter」——该形参是 variadic "any"，PG 推不出类型。
 * 外层有 .catch() 兜底，所以现象是「备份成功但审计日志每次静默丢失」，日志不翻不会发现。
 * mock 掉 db 的单测覆盖不到 SQL 类型推断，这里退而对源码下断言。
 */
describe('备份审计日志的绑定参数转型', () => {
  const source = readFileSync(path.join(__dirname, 'database-backup.ts'), 'utf8')
  const jsonbArgs = source.slice(
    source.indexOf('jsonb_build_object'),
    source.indexOf('jsonb_build_object') + 400,
  )

  it('jsonb_build_object 的四个参数都显式转型', () => {
    expect(jsonbArgs).toContain("'kind', ${status.kind}::text")
    expect(jsonbArgs).toContain("'state', ${status.state}::text")
    expect(jsonbArgs).toContain("'sizeBytes', ${status.sizeBytes || null}::bigint")
    expect(jsonbArgs).toContain("'errorCode', ${status.errorCode || null}::text")
  })
})

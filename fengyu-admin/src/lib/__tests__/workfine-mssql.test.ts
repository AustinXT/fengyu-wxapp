/**
 * parseMssqlConnString 单测 — ticket 2026-05-26 ELOGIN 修复
 *
 * 根因：admin 容器只注入 MSSQL_CONNECTION_STRING，旧代码只读分离变量 →
 * 空密码登录失败（ELOGIN）。本测试守护连接字符串解析与 envs/*.env 格式对齐。
 */
import { describe, it, expect } from 'vitest'
import { normalizeWorkfineAmount, parseMssqlConnString } from '../workfine-mssql'

describe('parseMssqlConnString', () => {
  it('解析 envs/prod.env 实际格式（Server 含端口）', () => {
    const r = parseMssqlConnString(
      'Server=47.96.87.33,1433;Database=wkdb_20220804_86cd3292;User Id=admin;Password=Se1Qimoh;TrustServerCertificate=True',
    )
    expect(r).toEqual({
      server: '47.96.87.33',
      port: 1433,
      database: 'wkdb_20220804_86cd3292',
      user: 'admin',
      password: 'Se1Qimoh',
    })
  })

  it('key 大小写不敏感 + 别名（Data Source / Initial Catalog / UID / PWD）', () => {
    const r = parseMssqlConnString(
      'data source=host;initial catalog=mydb;uid=sa;pwd=secret',
    )
    expect(r).toEqual({ server: 'host', database: 'mydb', user: 'sa', password: 'secret' })
  })

  it('Server 不含端口时不设 port', () => {
    const r = parseMssqlConnString('Server=host;User Id=u;Password=p')
    expect(r.server).toBe('host')
    expect(r.port).toBeUndefined()
  })

  it('忽略空值与未知 key，不抛错', () => {
    const r = parseMssqlConnString('Server=;Encrypt=false;Foo=bar;Password=p')
    expect(r.server).toBeUndefined()
    expect(r.password).toBe('p')
  })
})

describe('normalizeWorkfineAmount', () => {
  it('整数 ×10', () => {
    expect(normalizeWorkfineAmount(99)).toBe(990)
    expect(normalizeWorkfineAmount(0)).toBe(0)
  })

  it('1 位小数 ×10 还原为整数', () => {
    expect(normalizeWorkfineAmount(99.8)).toBe(998)
  })

  it('2 位小数 ×10 保留 1 位小数（无浮点末位误差）', () => {
    expect(normalizeWorkfineAmount(99.85)).toBe(998.5)
    // IEEE 754 边界检查：0.29 * 10 在浮点下为 2.9000000000000004，
    // helper 用整数运算应得到精确 2.9
    expect(normalizeWorkfineAmount(0.29)).toBe(2.9)
  })

  it('字符串入参（mssql decimal 大数返回 string 的情况）', () => {
    expect(normalizeWorkfineAmount('99.85')).toBe(998.5)
    expect(normalizeWorkfineAmount('  99.8 ')).toBe(998)
  })

  it('null / undefined / NaN / 空串 → 0', () => {
    expect(normalizeWorkfineAmount(null)).toBe(0)
    expect(normalizeWorkfineAmount(undefined)).toBe(0)
    expect(normalizeWorkfineAmount(NaN)).toBe(0)
    expect(normalizeWorkfineAmount('')).toBe(0)
    expect(normalizeWorkfineAmount('abc')).toBe(0)
  })

  it('负数 → 0（防御性兜底，WorkFine 不应出现负金额）', () => {
    expect(normalizeWorkfineAmount(-1)).toBe(0)
    expect(normalizeWorkfineAmount('-99.8')).toBe(0)
  })
})

/**
 * parseMssqlConnString 单测 — ticket 2026-05-26 ELOGIN 修复
 *
 * 根因：admin 容器只注入 MSSQL_CONNECTION_STRING，旧代码只读分离变量 →
 * 空密码登录失败（ELOGIN）。本测试守护连接字符串解析与 envs/*.env 格式对齐。
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeWorkfineAmount,
  parseMssqlConnString,
  WorkfineUnavailableError,
} from '../workfine-mssql'
import { actionErrorMessage } from '../action-error'

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

describe('WorkfineUnavailableError（WorkFine 不可用提示在 prod 的透传守护）', () => {
  // 根因：普通 Error 在 Next.js 生产构建会被脱敏（message 只剩通用文案），前端拿不到
  // 友好提示。必须带自定义 digest，前端 actionErrorMessage 才能从 digest 取回可读文案。
  it('带非空 digest 以扛住 prod 对 Server Action message 的脱敏', () => {
    const err = new WorkfineUnavailableError()
    expect(typeof err.digest).toBe('string')
    expect(err.digest.length).toBeGreaterThan(0)
  })

  it('前端展示干净友好文案，不暴露 INVALID_STATE / WORKFINE_UNAVAILABLE 前缀', () => {
    // actionErrorMessage 优先读 digest、剥一级前缀后展示——模拟 PullWorkfineDialog 的 catch
    const shown = actionErrorMessage(new WorkfineUnavailableError(), '搜索失败')
    expect(shown).toBe('WorkFine 历史数据库暂时不可用，请稍后重试或联系管理员')
    expect(shown).not.toContain('WORKFINE_UNAVAILABLE')
    expect(shown).not.toContain('INVALID_STATE')
  })

  it('message 保留 WORKFINE_UNAVAILABLE 子标签供 server 日志归类', () => {
    const err = new WorkfineUnavailableError()
    expect(err.message).toContain('WORKFINE_UNAVAILABLE')
    expect(err.name).toBe('WorkfineUnavailableError')
  })
})

/**
 * parseMssqlConnString 单测 — ticket 2026-05-26 ELOGIN 修复
 *
 * 根因：admin 容器只注入 MSSQL_CONNECTION_STRING，旧代码只读分离变量 →
 * 空密码登录失败（ELOGIN）。本测试守护连接字符串解析与 envs/*.env 格式对齐。
 */
import { describe, it, expect } from 'vitest'
import { parseMssqlConnString } from '../workfine-mssql'

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

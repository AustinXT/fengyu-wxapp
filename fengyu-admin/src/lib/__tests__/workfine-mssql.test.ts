/**
 * WorkFine MSSQL 客户端单测
 *
 * 覆盖：
 *   - parseMssqlConnString（envs/*.env 格式对齐，ticket 2026-05-26 ELOGIN 修复守护）
 *   - normalizeWorkfineAmount（金额 ×10 还原）
 *   - WorkfineUnavailableError（digest 透传扛 prod 脱敏 + 统一文案）
 *   - actionErrorMessage 脱敏扩展（框架级 "unexpected response" 等不再泄露给用户）
 *   - isTransientMssqlError 判定矩阵
 *   - runQuery 瞬态错误重试（mock mssql，via searchCustomersByPhone）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted 早于 import 执行：清除 MOCK_WORKFINE，确保 workfine-mssql 模块加载时
// USE_MOCK=false（走真 mssql 路径，由下方 vi.mock 替身接管），重试测试才有效。
const { queryMock } = vi.hoisted(() => {
  delete process.env.MOCK_WORKFINE
  return { queryMock: vi.fn() }
})

// 用 mssql 替身接管 workfine-mssql 的 ConnectionPool：注入可控 queryMock，
// 使 runQuery 的瞬态重试可被精确观测（第 N 次抛什么错、共调几次）。
vi.mock('mssql', () => {
  const fakePool = {
    connected: true,
    request: () => ({ input: () => ({ query: queryMock }) }),
    close: () => Promise.resolve(undefined),
    on: () => {},
    connect: () => Promise.resolve(fakePool),
  }
  return {
    default: {
      // getPool 用 `new mssql.ConnectionPool(config)`；构造函数返回带 connect 的对象即可。
      ConnectionPool: function ConnectionPool() {
        return fakePool
      },
      NVarChar: () => 'nvarchar',
    },
  }
})

import {
  normalizeWorkfineAmount,
  parseMssqlConnString,
  WorkfineUnavailableError,
  isTransientMssqlError,
  searchCustomersByPhone,
  queryOrdersByCustomerId,
} from '../workfine-mssql'
import { actionErrorMessage } from '../action-error'
import { WORKFINE_CONNECT_ERROR_MSG } from '../workfine-constants'

// 清理 workfine-mssql 的 globalThis 池缓存 + 重置 query 行为，隔离每个 case
beforeEach(() => {
  const g = globalThis as typeof globalThis & {
    __workfineMssqlPool?: unknown
    __workfineMssqlPoolPromise?: unknown
  }
  g.__workfineMssqlPool = null
  g.__workfineMssqlPoolPromise = null
  queryMock.mockReset()
})

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

// actionErrorMessage 本身的通用行为（脱敏话术 / 网络错 / digest 口径）归 src/lib/action-error.test.ts
// 单一归属，本文件只保留 WorkFine 专属的那条链路（issue #133 去重）。
describe('WorkfineUnavailableError（WorkFine 不可用提示在 prod 的透传守护）', () => {
  // 根因：普通 Error 在 Next.js 生产构建会被脱敏（message 只剩通用文案），前端拿不到
  // 友好提示。必须带自定义 digest，前端 actionErrorMessage 才能从 digest 取回可读文案。
  it('带非空 digest 以扛住 prod 对 Server Action message 的脱敏', () => {
    const err = new WorkfineUnavailableError()
    expect(typeof err.digest).toBe('string')
    expect(err.digest.length).toBeGreaterThan(0)
  })

  it('前端展示统一友好文案，不暴露 INVALID_STATE / WORKFINE_UNAVAILABLE 前缀', () => {
    // actionErrorMessage 优先读 digest、剥一级前缀后展示——模拟 PullWorkfineDialog 的 catch
    const shown = actionErrorMessage(new WorkfineUnavailableError(), '搜索失败')
    expect(shown).toBe(WORKFINE_CONNECT_ERROR_MSG)
    expect(shown).not.toContain('WORKFINE_UNAVAILABLE')
    expect(shown).not.toContain('INVALID_STATE')
  })

  it('message 保留 WORKFINE_UNAVAILABLE 子标签供 server 日志归类', () => {
    const err = new WorkfineUnavailableError()
    expect(err.message).toContain('WORKFINE_UNAVAILABLE')
    expect(err.name).toBe('WorkfineUnavailableError')
  })
})

describe('isTransientMssqlError（瞬态错误判定矩阵）', () => {
  it('连接层 name（ConnectionError / ConnectionLost）→ 瞬态', () => {
    expect(
      isTransientMssqlError({ name: 'ConnectionError', message: 'connection closed' }),
    ).toBe(true)
    expect(isTransientMssqlError({ name: 'ConnectionLost' })).toBe(true)
  })
  it('socket 错误码 ECONNRESET/ESOCKET/ETIMEDOUT/EPIPE/ECONNREFUSED → 瞬态', () => {
    expect(isTransientMssqlError({ code: 'ECONNRESET' })).toBe(true)
    expect(isTransientMssqlError({ code: 'ESOCKET' })).toBe(true)
    expect(isTransientMssqlError({ code: 'ETIMEDOUT' })).toBe(true)
    expect(isTransientMssqlError({ code: 'econnreset' })).toBe(true) // 大小写不敏感
  })
  it('message 含 "connection lost" / "socket hang up" / "read econnreset" → 瞬态', () => {
    expect(isTransientMssqlError({ message: 'Connection lost' })).toBe(true)
    expect(isTransientMssqlError({ message: 'socket hang up' })).toBe(true)
    expect(isTransientMssqlError({ message: 'read ECONNRESET' })).toBe(true)
  })
  it('登录失败(ELOGIN)/语法错等 → 非瞬态（不重试）', () => {
    expect(
      isTransientMssqlError({ name: 'RequestError', code: 'ELOGIN', message: 'login failed' }),
    ).toBe(false)
    expect(isTransientMssqlError({ name: 'RequestError', message: 'Invalid column name' })).toBe(false)
  })
  it('null / undefined / 非对象 → false', () => {
    expect(isTransientMssqlError(null)).toBe(false)
    expect(isTransientMssqlError(undefined)).toBe(false)
    expect(isTransientMssqlError('string')).toBe(false)
  })
})

describe('runQuery 瞬态错误重试（via searchCustomersByPhone）', () => {
  it('瞬态错误(ECONNRESET)重试一次后成功', async () => {
    queryMock
      .mockRejectedValueOnce({ code: 'ECONNRESET', message: 'read ECONNRESET' })
      .mockResolvedValueOnce({
        recordset: [{ customer_id: 'C1', name: '罗珍', phone: '13576939399' }],
      })
    const res = await searchCustomersByPhone('13576939399')
    expect(res).toEqual([{ customerId: 'C1', name: '罗珍', phone: '13576939399' }])
    expect(queryMock).toHaveBeenCalledTimes(2)
  })

  it('非瞬态错误(ELOGIN)不重试，直接抛 WorkfineUnavailableError', async () => {
    queryMock.mockRejectedValueOnce({
      name: 'RequestError',
      code: 'ELOGIN',
      message: 'login failed',
    })
    await expect(searchCustomersByPhone('13576939399')).rejects.toBeInstanceOf(
      WorkfineUnavailableError,
    )
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('连续瞬态错误（重试也失败）→ 抛 WorkfineUnavailableError', async () => {
    queryMock
      .mockRejectedValueOnce({ code: 'ECONNRESET', message: 'read ECONNRESET' })
      .mockRejectedValueOnce({ code: 'ESOCKET', message: 'socket hang up' })
    await expect(searchCustomersByPhone('13576939399')).rejects.toBeInstanceOf(
      WorkfineUnavailableError,
    )
    expect(queryMock).toHaveBeenCalledTimes(2)
  })
})

describe('queryOrdersByCustomerId（销售/转换/回款三表 UNION 结果映射）', () => {
  it('src_type → sourceType 映射三类，回款单透传 original_order_no，amount ×10 还原', async () => {
    queryMock.mockResolvedValueOnce({
      recordset: [
        {
          legacy_order_no: 'FY-XSD1',
          sale_date: new Date('2023-01-01T00:00:00.000Z'),
          market_name: '南昌市场',
          store_name: '南昌万科店',
          legacy_customer_id: 'FYGK-1',
          customer_name: '汪汪',
          amount: 100,
          phone: '13800138000',
          src_type: '销售单',
          original_order_no: null,
        },
        {
          legacy_order_no: 'FY-ABZH1',
          sale_date: new Date('2023-02-01T00:00:00.000Z'),
          market_name: '南昌市场',
          store_name: '南昌万科店',
          legacy_customer_id: 'FYGK-1',
          customer_name: '汪汪',
          amount: 10,
          phone: '13800138000',
          src_type: '转换单',
          original_order_no: null,
        },
        {
          legacy_order_no: 'FY-HKD1',
          sale_date: new Date('2023-03-01T00:00:00.000Z'),
          market_name: '南昌市场',
          store_name: '南昌万科店',
          legacy_customer_id: 'FYGK-1',
          customer_name: '汪汪',
          amount: 50,
          phone: '13800138000',
          src_type: '回款单',
          original_order_no: 'FY-XSD1',
        },
      ],
    })
    const res = await queryOrdersByCustomerId('FYGK-1')
    expect(res).toHaveLength(3)
    expect(res.map((o) => o.sourceType).sort()).toEqual(['回款单', '转换单', '销售单'])
    // amount ×10 还原（100→1000, 10→100, 50→500）
    expect(res[0].amount).toBe(1000)
    expect(res[1].amount).toBe(100)
    expect(res[2].amount).toBe(500)
    // 回款单透传 original_order_no；销售/转换为 null
    expect(res.find((o) => o.sourceType === '回款单')!.originalOrderNo).toBe('FY-XSD1')
    expect(res.find((o) => o.sourceType === '销售单')!.originalOrderNo).toBeNull()
    expect(res.find((o) => o.sourceType === '转换单')!.originalOrderNo).toBeNull()
  })
})

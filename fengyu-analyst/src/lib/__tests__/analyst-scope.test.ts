import { describe, expect, it } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import {
  analystScopeCacheKey,
  getEffectiveAnalystScope,
  hasGlobalAnalystScope,
  scopeFilterSql,
  scopeRangeSql,
  validateAnalystScopeWithOptions,
  type AnalystScope,
  type AnalystScopeOptions,
} from "../analyst-scope"
import type { AuthSession, RoleType } from "../types"

const dialect = new PgDialect()

const squeeze = (text: string) => text.replace(/\s+/g, " ").trim()

/** 在营门店子查询（#421，跟随数据中心 #401）：只看门店组织节点 is_active，不看 is_closed */
const activeStoreClause = (col: string) =>
  `${col} IN ( SELECT active_store.store_id FROM stores active_store JOIN org_nodes active_node ON active_store.org_node_id = active_node.id WHERE active_node.type = '门店' AND active_node.is_active = TRUE )`

function render(fragment: ReturnType<typeof scopeFilterSql>) {
  const query = dialect.sqlToQuery(fragment)
  return { sql: query.sql.toLowerCase(), raw: query.sql, params: query.params }
}

function makeSession(
  roles: Array<{ role: RoleType; scopeType: "总部" | "市场" | "门店"; scopeId?: string }>,
  scopeStoreIds: string[],
): AuthSession {
  return {
    employeeId: "e1",
    name: "测试员工",
    phone: "13800000000",
    roles: roles.map((role) => ({
      role: role.role,
      scopeType: role.scopeType,
      scopeId: role.scopeId ?? "scope-node",
    })),
    permissions: { actions: [], scopeStoreIds },
  }
}

describe("analyst scope", () => {
  const allScope: AnalystScope = { type: "all" }

  it("admin role is global even when scopeStoreIds is empty", () => {
    const session = makeSession([{ role: "admin", scopeType: "总部" }], [])
    const { raw, params } = render(scopeFilterSql(session, allScope, "so.store_id"))

    expect(hasGlobalAnalystScope(session)).toBe(true)
    // 全局账号不再是 TRUE：仍须排除已停用门店（以及门店为空 / 悬空的行）
    expect(squeeze(raw)).toBe(activeStoreClause("so.store_id"))
    expect(params).toEqual([])
  })

  it("headquarters scope is also global for analyst aggregation", () => {
    const session = makeSession([{ role: "manager", scopeType: "总部" }], [])
    const { raw } = render(scopeFilterSql(session, allScope, "so.store_id"))

    expect(hasGlobalAnalystScope(session)).toBe(true)
    expect(squeeze(raw)).toBe(activeStoreClause("so.store_id"))
  })

  it("non global empty store scope returns FALSE", () => {
    const session = makeSession([{ role: "manager", scopeType: "门店" }], [])
    const { raw } = render(scopeFilterSql(session, allScope, "so.store_id"))

    expect(raw.trim().toUpperCase()).toBe("FALSE")
  })

  it("non global account scope filters by visible store ids", () => {
    const session = makeSession([{ role: "manager", scopeType: "市场" }], ["S1", "S2"])
    const { sql, raw, params } = render(scopeFilterSql(session, allScope, "so.store_id"))

    expect(sql).toContain("so.store_id in")
    expect(params).toEqual(["S1", "S2"])
    expect(squeeze(raw).startsWith(`${activeStoreClause("so.store_id")} AND `)).toBe(true)
  })

  it("market scope expands org node to store_id through stores.org_node_id", () => {
    const session = makeSession([{ role: "admin", scopeType: "总部" }], [])
    const { sql, raw, params } = render(scopeFilterSql(session, { type: "market", id: "MKT-1" }, "so.store_id"))

    expect(sql).toContain("from stores s")
    expect(sql).toContain("join org_nodes o on o.id = s.org_node_id")
    expect(sql).toContain("o.parent_id =")
    expect(params).toEqual(["MKT-1"])
    expect(squeeze(raw).startsWith(`${activeStoreClause("so.store_id")} AND `)).toBe(true)
  })

  it("store scope filters directly by business store_id", () => {
    const session = makeSession([{ role: "admin", scopeType: "总部" }], [])
    const { sql, raw, params } = render(scopeFilterSql(session, { type: "store", id: "STORE-9" }, "so.store_id"))

    expect(sql).toContain("so.store_id =")
    expect(params).toEqual(["STORE-9"])
    expect(squeeze(raw).startsWith(`${activeStoreClause("so.store_id")} AND `)).toBe(true)
  })

  it("supports customer bound store columns", () => {
    const session = makeSession([{ role: "manager", scopeType: "门店" }], ["S1"])
    const { sql, raw, params } = render(scopeFilterSql(session, allScope, "c.bound_store_id"))

    expect(sql).toContain("c.bound_store_id in")
    expect(params).toEqual(["S1"])
    expect(squeeze(raw).startsWith(`${activeStoreClause("c.bound_store_id")} AND `)).toBe(true)
  })

  it("every store column the boards pass keeps the active-store clause on that column (#421)", () => {
    const global = makeSession([{ role: "admin", scopeType: "总部" }], [])
    const scoped = makeSession([{ role: "manager", scopeType: "门店" }], ["S1"])
    for (const col of ["so.store_id", "c.bound_store_id", "svc.store_id", "mo.store_id", "yo.store_id"]) {
      expect(squeeze(render(scopeFilterSql(global, allScope, col)).raw)).toBe(activeStoreClause(col))
      expect(squeeze(render(scopeFilterSql(global, { type: "store", id: "S9" }, col)).raw)).toBe(
        `${activeStoreClause(col)} AND ${col} = $1`,
      )
      expect(squeeze(render(scopeFilterSql(scoped, allScope, col)).raw)).toBe(`${activeStoreClause(col)} AND ${col} IN ($1)`)
    }
  })

  describe("validateAnalystScopeWithOptions：停用门店（#421）", () => {
    // 下拉只列在营门店；停用门店不在 options 里
    const options: AnalystScopeOptions = {
      topLevel: "store",
      markets: [{ id: "M1", name: "市场一", stores: [{ storeId: "ACTIVE", storeName: "在营店" }] }],
    }
    const storeAccount = makeSession([{ role: "manager", scopeType: "门店" }], ["ACTIVE", "STOPPED"])

    it("store account may open its active store", () => {
      expect(() => validateAnalystScopeWithOptions(storeAccount, { type: "store", id: "ACTIVE" }, options)).not.toThrow()
    })

    it("store account is denied its own stopped store even though scopeStoreIds contains it", () => {
      expect(() => validateAnalystScopeWithOptions(storeAccount, { type: "store", id: "STOPPED" }, options)).toThrow(
        "PERMISSION_DENIED",
      )
    })

    it("store account is denied another store", () => {
      expect(() => validateAnalystScopeWithOptions(storeAccount, { type: "store", id: "OTHER" }, options)).toThrow(
        "PERMISSION_DENIED",
      )
    })

    it("global account passes validation; SQL then yields zero rows for a stopped store", () => {
      const admin = makeSession([{ role: "admin", scopeType: "总部" }], [])
      expect(() => validateAnalystScopeWithOptions(admin, { type: "store", id: "STOPPED" }, options)).not.toThrow()
      expect(squeeze(render(scopeFilterSql(admin, { type: "store", id: "STOPPED" }, "so.store_id")).raw)).toBe(
        `${activeStoreClause("so.store_id")} AND so.store_id = $1`,
      )
    })
  })

  describe("scopeRangeSql（首次基线用，不含在营过滤，#421）", () => {
    it("global all scope is TRUE: stopped stores still count toward first-order baseline", () => {
      const session = makeSession([{ role: "admin", scopeType: "总部" }], [])
      const { raw, params } = render(scopeRangeSql(session, allScope, "so.store_id"))

      expect(raw.trim().toUpperCase()).toBe("TRUE")
      expect(params).toEqual([])
    })

    it("non global empty store scope is still FALSE", () => {
      const session = makeSession([{ role: "manager", scopeType: "门店" }], [])
      const { raw } = render(scopeRangeSql(session, allScope, "so.store_id"))

      expect(raw.trim().toUpperCase()).toBe("FALSE")
    })

    it("keeps account and selected scope but never the active-store clause", () => {
      const session = makeSession([{ role: "manager", scopeType: "市场" }], ["S1"])
      const range = render(scopeRangeSql(session, { type: "market", id: "MKT-1" }, "so.store_id"))
      const filter = render(scopeFilterSql(session, { type: "market", id: "MKT-1" }, "so.store_id"))

      expect(range.sql).not.toContain("active_node")
      expect(range.params).toEqual(["S1", "MKT-1"])
      expect(squeeze(filter.raw)).toBe(`${activeStoreClause("so.store_id")} AND ${squeeze(range.raw)}`)
      expect(filter.params).toEqual(range.params)
    })

    it("rejects unsafe column names like scopeFilterSql", () => {
      const session = makeSession([{ role: "admin", scopeType: "总部" }], [])
      expect(() => scopeRangeSql(session, allScope, "so.store_id; drop table x")).toThrow("INVALID_PARAMS")
    })
  })

  it("cache key includes account scope and selected org scope", () => {
    const session = makeSession([{ role: "manager", scopeType: "市场" }], ["S2", "S1"])

    expect(analystScopeCacheKey(session, { type: "market", id: "MKT-1" })).toBe("S1,S2|market:MKT-1")
  })

  it("keeps all scope for global analyst options", () => {
    const options: AnalystScopeOptions = { topLevel: "all", markets: [] }

    expect(getEffectiveAnalystScope(allScope, options)).toEqual(allScope)
  })

  it("defaults missing scope to the first visible market for market accounts", () => {
    const options: AnalystScopeOptions = {
      topLevel: "market",
      markets: [
        {
          id: "MKT-1",
          name: "南昌市场",
          stores: [{ storeId: "S1", storeName: "南昌一店" }],
        },
      ],
    }

    expect(getEffectiveAnalystScope(allScope, options)).toEqual({ type: "market", id: "MKT-1" })
  })

  it("defaults missing scope to the first visible store for store accounts", () => {
    const options: AnalystScopeOptions = {
      topLevel: "store",
      markets: [
        {
          id: "MKT-1",
          name: "南昌市场",
          stores: [{ storeId: "S1", storeName: "南昌一店" }],
        },
      ],
    }

    expect(getEffectiveAnalystScope(allScope, options)).toEqual({ type: "store", id: "S1" })
  })

  it("returns null when a scoped account has no visible market or store", () => {
    const options: AnalystScopeOptions = { topLevel: "market", markets: [] }

    expect(getEffectiveAnalystScope(allScope, options)).toBeNull()
  })
})

import { describe, expect, it } from "vitest"
import {
  aggregateFunnelBySource,
  aggregateFunnelKpi,
  filterNewCustomerFunnelListEntries,
  previousPeriodRange,
  previousYearRange,
  resolveServiceBucket,
  type NewCustomerFunnelEntry,
  type RequiredNewCustomerFunnelFilters,
} from "../new-customer-funnel-utils"

function entry(partial: Partial<NewCustomerFunnelEntry>): NewCustomerFunnelEntry {
  const entryDate = partial.entryDate ?? "2026-01-01"
  const firstServiceDate = partial.firstServiceDate ?? null
  return {
    customerId: partial.customerId ?? `c-${Math.random()}`,
    customerCode: partial.customerCode ?? "C001",
    customerName: partial.customerName ?? "测试顾客",
    source: partial.source ?? "美团",
    month: partial.month ?? entryDate.slice(0, 7),
    entryDate,
    market: partial.market ?? "南昌",
    store: partial.store ?? "南昌一店",
    firstServiceDate,
    serviceBucket: partial.serviceBucket ?? resolveServiceBucket(entryDate, firstServiceDate),
    becameMemberAt: partial.becameMemberAt ?? null,
    firstMembershipAmount: partial.firstMembershipAmount ?? 0,
    annualContributionAmount: partial.annualContributionAmount ?? 0,
  }
}

describe("new customer funnel utils", () => {
  it("splits first service into mutually exclusive T+30/T+60/T+90 buckets", () => {
    expect(resolveServiceBucket("2026-01-01", "2026-01-31")).toBe("t30")
    expect(resolveServiceBucket("2026-01-01", "2026-02-01")).toBe("t60")
    expect(resolveServiceBucket("2026-01-01", "2026-03-02")).toBe("t60")
    expect(resolveServiceBucket("2026-01-01", "2026-03-03")).toBe("t90")
    expect(resolveServiceBucket("2026-01-01", "2026-04-01")).toBe("t90")
    expect(resolveServiceBucket("2026-01-01", "2026-04-02")).toBeNull()
  })

  it("counts members only from arrived customers", () => {
    const kpi = aggregateFunnelKpi([
      entry({
        customerId: "arrived-member",
        firstServiceDate: "2026-01-10",
        becameMemberAt: "2026-01-05T00:00:00.000Z",
        firstMembershipAmount: 1980,
        annualContributionAmount: 3000,
      }),
      entry({
        customerId: "not-arrived-member",
        becameMemberAt: "2026-01-06T00:00:00.000Z",
        firstMembershipAmount: 1980,
        annualContributionAmount: 2000,
      }),
      entry({
        customerId: "arrived-nonmember",
        firstServiceDate: "2026-02-15",
      }),
    ])

    expect(kpi.newCustomerCount).toBe(3)
    expect(kpi.arrivedCount).toBe(2)
    expect(kpi.memberCustomerCount).toBe(1)
    expect(kpi.memberConversionRate).toBe(0.5)
    expect(kpi.firstMembershipAmount).toBe(1980)
    expect(kpi.annualContributionAmount).toBe(3000)
  })

  it("filters customer lists by arrived and member funnel semantics", () => {
    const arrivedMember = entry({
      customerId: "arrived-member",
      firstServiceDate: "2026-01-10",
      becameMemberAt: "2026-01-12T00:00:00.000Z",
    })
    const arrivedNonMember = entry({
      customerId: "arrived-nonmember",
      firstServiceDate: "2026-01-15",
    })
    const notArrivedMember = entry({
      customerId: "not-arrived-member",
      becameMemberAt: "2026-01-20T00:00:00.000Z",
    })
    const rows = [arrivedMember, arrivedNonMember, notArrivedMember]

    expect(filterNewCustomerFunnelListEntries(rows, "arrived").map((row) => row.customerId)).toEqual([
      "arrived-member",
      "arrived-nonmember",
    ])
    expect(filterNewCustomerFunnelListEntries(rows, "not_arrived").map((row) => row.customerId)).toEqual([
      "not-arrived-member",
    ])
    expect(filterNewCustomerFunnelListEntries(rows, "member").map((row) => row.customerId)).toEqual([
      "arrived-member",
    ])
  })

  it("keeps every configured source in source breakdown", () => {
    const rows = aggregateFunnelBySource([
      entry({ customerId: "a", source: "美团" }),
      entry({ customerId: "b", source: "转让店", firstServiceDate: "2026-01-15" }),
    ])

    expect(rows.map((row) => row.name)).toContain("美团")
    expect(rows.map((row) => row.name)).toContain("转让店")
    expect(rows.map((row) => row.name)).toContain("未填写")
    expect(rows.find((row) => row.name === "美团")?.newCustomerCount).toBe(1)
    expect(rows.find((row) => row.name === "未填写")?.newCustomerCount).toBe(0)
  })

  it("derives previous year and previous period month ranges", () => {
    const filters: RequiredNewCustomerFunnelFilters = {
      startMonth: "2026-03",
      endMonth: "2026-05",
      unitLevel: "market",
      tableMode: "months",
      source: "",
      market: "",
      store: "",
    }

    expect(previousYearRange(filters)).toEqual({ startMonth: "2025-03", endMonth: "2025-05" })
    expect(previousPeriodRange(filters)).toEqual({ startMonth: "2025-12", endMonth: "2026-02" })
  })
})

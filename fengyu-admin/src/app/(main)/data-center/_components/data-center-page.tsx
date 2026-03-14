"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Select } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/ui/data-table"
import { formatCurrency } from "@/lib/utils"
import {
  getReturnRateByMonth, getReturnRateByStore,
  getCategoryMix, getProductRank,
  getOperationsFunnel,
  getStaffEfficiency,
  getRankings,
  type ReturnRateRow, type StoreReturnRate,
  type CategoryMixRow, type ProductRankRow,
  type FunnelRow,
  type StaffEfficiencyRow,
  type RankingRow, type DateFilter,
} from "@/actions/data-center"

// ─── 颜色常量 ───────────────────────────────────────────────

const BRAND_RED = "#C0322A"
const CHART_COLORS = ["#C0322A", "#D4820A", "#3D8A5A", "#5E8BB3", "#8B5CF6", "#EC4899"]
const PIE_COLORS = ["#C0322A", "#D4820A", "#3D8A5A", "#5E8BB3", "#888888"]

// ─── 筛选器组件 ──────────────────────────────────────────────

function FilterBar({
  stores,
  filter,
  onChange,
}: {
  stores: Array<{ storeId: string; storeName: string }>
  filter: DateFilter
  onChange: (f: DateFilter) => void
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <Select
        value={filter.storeId ?? ""}
        onChange={(e) => onChange({ ...filter, storeId: e.target.value || undefined })}
        className="w-40"
      >
        <option value="">全部门店</option>
        {stores.map((s) => (
          <option key={s.storeId} value={s.storeId}>{s.storeName}</option>
        ))}
      </Select>
      <div className="flex items-center gap-1.5">
        <Input
          type="date"
          value={filter.startDate ?? ""}
          onChange={(e) => onChange({ ...filter, startDate: e.target.value || undefined })}
          className="w-36"
        />
        <span className="text-[var(--muted-foreground)]">~</span>
        <Input
          type="date"
          value={filter.endDate ?? ""}
          onChange={(e) => onChange({ ...filter, endDate: e.target.value || undefined })}
          className="w-36"
        />
      </div>
    </div>
  )
}

// ─── 指标卡 ─────────────────────────────────────────────────

function MetricCard({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <Card>
      <CardContent className="p-4 text-center">
        <div className="text-sm text-[var(--muted-foreground)]">{label}</div>
        <div className="text-2xl font-bold mt-1" style={{ color: BRAND_RED }}>
          {value}
          {unit && <span className="text-sm font-normal text-[var(--muted-foreground)] ml-1">{unit}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Tab 1: 客户回店率 ─────────────────────────────────────

function ReturnRateTab({
  stores, filter, onChange,
}: {
  stores: Array<{ storeId: string; storeName: string }>
  filter: DateFilter
  onChange: (f: DateFilter) => void
}) {
  const [monthData, setMonthData] = useState<ReturnRateRow[]>([])
  const [storeData, setStoreData] = useState<StoreReturnRate[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [m, s] = await Promise.all([
        getReturnRateByMonth(filter),
        getReturnRateByStore(filter),
      ])
      setMonthData(m)
      setStoreData(s)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  const storeColumns: Column<StoreReturnRate>[] = [
    { key: "storeName", header: "门店" },
    { key: "totalCustomers", header: "总顾客数" },
    { key: "returningCustomers", header: "回头客数" },
    {
      key: "returnRate",
      header: "回店率",
      cell: (row) => (
        <span className="font-medium" style={{ color: BRAND_RED }}>{row.returnRate}%</span>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <FilterBar stores={stores} filter={filter} onChange={onChange} />
      {loading ? (
        <Card><CardContent className="p-12 text-center text-[var(--muted-foreground)]">加载中...</CardContent></Card>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4">
            <MetricCard
              label="平均回店率"
              value={monthData.length > 0
                ? (monthData.reduce((s, r) => s + r.returnRate, 0) / monthData.length).toFixed(1)
                : "0"}
              unit="%"
            />
            <MetricCard
              label="总顾客数"
              value={storeData.reduce((s, r) => s + r.totalCustomers, 0)}
            />
            <MetricCard
              label="回头客数"
              value={storeData.reduce((s, r) => s + r.returningCustomers, 0)}
            />
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">月度回店率趋势</CardTitle></CardHeader>
            <CardContent>
              {monthData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={monthData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                    <YAxis unit="%" tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v) => [`${v}%`, "回店率"]} />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="returnRate"
                      name="回店率"
                      stroke={BRAND_RED}
                      strokeWidth={2}
                      dot={{ r: 4, fill: BRAND_RED }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-center py-12 text-[var(--muted-foreground)]">暂无数据</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">门店回店率对比</CardTitle></CardHeader>
            <CardContent>
              <DataTable columns={storeColumns} data={storeData} emptyText="暂无数据" />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

// ─── Tab 2: 品项占比 ────────────────────────────────────────

function CategoryMixTab({
  stores, filter, onChange,
}: {
  stores: Array<{ storeId: string; storeName: string }>
  filter: DateFilter
  onChange: (f: DateFilter) => void
}) {
  const [mixData, setMixData] = useState<CategoryMixRow[]>([])
  const [productData, setProductData] = useState<ProductRankRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [m, p] = await Promise.all([
        getCategoryMix(filter),
        getProductRank(filter),
      ])
      setMixData(m)
      setProductData(p)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  const productColumns: Column<ProductRankRow>[] = [
    {
      key: "productName",
      header: "商品名称",
      cell: (row) => <span className="font-medium">{row.productName}</span>,
    },
    {
      key: "productKind",
      header: "品项分类",
      cell: (row) => <Badge variant="outline">{row.productKind}</Badge>,
    },
    { key: "orderCount", header: "销售数量" },
    {
      key: "totalAmount",
      header: "销售金额",
      cell: (row) => <span className="font-medium">{formatCurrency(row.totalAmount)}</span>,
    },
  ]

  return (
    <div className="space-y-4">
      <FilterBar stores={stores} filter={filter} onChange={onChange} />
      {loading ? (
        <Card><CardContent className="p-12 text-center text-[var(--muted-foreground)]">加载中...</CardContent></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-base">品项占比分布</CardTitle></CardHeader>
              <CardContent>
                {mixData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie
                        data={mixData}
                        dataKey="totalAmount"
                        nameKey="productKind"
                        cx="50%"
                        cy="50%"
                        outerRadius={100}
                        label={(props) => `${props.name ?? ''} ${((props.percent ?? 0) * 100).toFixed(1)}%`}
                      >
                        {mixData.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v) => [formatCurrency(Number(v)), "金额"]} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="text-center py-12 text-[var(--muted-foreground)]">暂无数据</div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">品项金额统计</CardTitle></CardHeader>
              <CardContent>
                {mixData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={mixData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="productKind" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(v) => [formatCurrency(Number(v)), "金额"]} />
                      <Bar dataKey="totalAmount" name="金额" fill={BRAND_RED} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="text-center py-12 text-[var(--muted-foreground)]">暂无数据</div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">商品销售排行</CardTitle></CardHeader>
            <CardContent>
              <DataTable columns={productColumns} data={productData} emptyText="暂无数据" />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

// ─── Tab 3: 经营动线 ────────────────────────────────────────

function FunnelTab({
  stores, filter, onChange,
}: {
  stores: Array<{ storeId: string; storeName: string }>
  filter: DateFilter
  onChange: (f: DateFilter) => void
}) {
  const [data, setData] = useState<FunnelRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await getOperationsFunnel(filter))
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  const maxCount = Math.max(...data.map(d => d.count), 1)

  return (
    <div className="space-y-4">
      <FilterBar stores={stores} filter={filter} onChange={onChange} />
      {loading ? (
        <Card><CardContent className="p-12 text-center text-[var(--muted-foreground)]">加载中...</CardContent></Card>
      ) : (
        <>
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-4">
            {data.map((d) => (
              <MetricCard key={d.stage} label={d.stage} value={d.count} />
            ))}
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">经营漏斗</CardTitle></CardHeader>
            <CardContent>
              {data.length > 0 ? (
                <ResponsiveContainer width="100%" height={350}>
                  <BarChart data={data} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis type="number" tick={{ fontSize: 12 }} />
                    <YAxis dataKey="stage" type="category" tick={{ fontSize: 12 }} width={80} />
                    <Tooltip />
                    <Bar dataKey="count" name="数量" radius={[0, 4, 4, 0]}>
                      {data.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-center py-12 text-[var(--muted-foreground)]">暂无数据</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">转化率分析</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-3">
                {data.map((d, i) => {
                  const prevCount = i > 0 ? data[i - 1].count : d.count
                  const rate = prevCount > 0 ? Math.round(d.count / prevCount * 1000) / 10 : 0
                  return (
                    <div key={d.stage} className="flex items-center gap-3">
                      <div className="w-20 text-sm font-medium shrink-0">{d.stage}</div>
                      <div className="flex-1 h-8 bg-[var(--muted)] rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${maxCount > 0 ? (d.count / maxCount) * 100 : 0}%`,
                            backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
                          }}
                        />
                      </div>
                      <div className="w-16 text-right text-sm font-medium">{d.count}</div>
                      {i > 0 && (
                        <Badge variant="outline" className="w-16 justify-center">
                          {rate}%
                        </Badge>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

// ─── Tab 4: 人效分析 ────────────────────────────────────────

function EfficiencyTab({
  stores, filter, onChange,
}: {
  stores: Array<{ storeId: string; storeName: string }>
  filter: DateFilter
  onChange: (f: DateFilter) => void
}) {
  const [data, setData] = useState<StaffEfficiencyRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await getStaffEfficiency(filter))
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  const columns: Column<StaffEfficiencyRow>[] = [
    {
      key: "employeeName",
      header: "员工",
      cell: (row) => <span className="font-medium">{row.employeeName}</span>,
    },
    { key: "storeName", header: "门店" },
    { key: "orderCount", header: "开单数" },
    {
      key: "totalRevenue",
      header: "总业绩",
      cell: (row) => <span className="font-medium">{formatCurrency(row.totalRevenue)}</span>,
    },
    {
      key: "avgTransaction",
      header: "客单价",
      cell: (row) => <span>{formatCurrency(row.avgTransaction)}</span>,
    },
    { key: "serviceCount", header: "完成服务数" },
  ]

  const chartData = data.slice(0, 15)

  return (
    <div className="space-y-4">
      <FilterBar stores={stores} filter={filter} onChange={onChange} />
      {loading ? (
        <Card><CardContent className="p-12 text-center text-[var(--muted-foreground)]">加载中...</CardContent></Card>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-4">
            <MetricCard label="员工总数" value={data.length} />
            <MetricCard
              label="总业绩"
              value={formatCurrency(data.reduce((s, r) => s + r.totalRevenue, 0))}
            />
            <MetricCard
              label="平均客单价"
              value={formatCurrency(
                data.length > 0
                  ? data.reduce((s, r) => s + r.avgTransaction, 0) / data.length
                  : 0
              )}
            />
            <MetricCard
              label="总服务数"
              value={data.reduce((s, r) => s + r.serviceCount, 0)}
            />
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">员工业绩排行</CardTitle></CardHeader>
            <CardContent>
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={350}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="employeeName" tick={{ fontSize: 11 }} angle={-30} textAnchor="end" height={60} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v) => [formatCurrency(Number(v)), "业绩"]} />
                    <Bar dataKey="totalRevenue" name="业绩" fill={BRAND_RED} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-center py-12 text-[var(--muted-foreground)]">暂无数据</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">人效明细</CardTitle></CardHeader>
            <CardContent>
              <DataTable columns={columns} data={data} emptyText="暂无数据" />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

// ─── Tab 5: 排行榜 ──────────────────────────────────────────

function RankingTab({
  stores, filter, onChange,
}: {
  stores: Array<{ storeId: string; storeName: string }>
  filter: DateFilter
  onChange: (f: DateFilter) => void
}) {
  const [staffRank, setStaffRank] = useState<RankingRow[]>([])
  const [productRank, setProductRank] = useState<RankingRow[]>([])
  const [customerRank, setCustomerRank] = useState<RankingRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await getRankings(filter)
      setStaffRank(r.staffByRevenue)
      setProductRank(r.productsByRevenue)
      setCustomerRank(r.customersBySpend)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load])

  const rankColumns: Column<RankingRow>[] = [
    {
      key: "rank",
      header: "排名",
      cell: (row) => {
        const medal = row.rank <= 3
          ? ["", "🥇", "🥈", "🥉"][row.rank]
          : String(row.rank)
        return <span className="font-medium">{medal}</span>
      },
    },
    {
      key: "name",
      header: "名称",
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "subtitle",
      header: "分类",
      cell: (row) => <Badge variant="outline">{row.subtitle}</Badge>,
    },
    {
      key: "value",
      header: "金额",
      cell: (row) => (
        <span className="font-medium" style={{ color: BRAND_RED }}>
          {formatCurrency(row.value)}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <FilterBar stores={stores} filter={filter} onChange={onChange} />
      {loading ? (
        <Card><CardContent className="p-12 text-center text-[var(--muted-foreground)]">加载中...</CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">员工业绩 TOP 10</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable columns={rankColumns} data={staffRank} emptyText="暂无数据" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">商品销售 TOP 10</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable columns={rankColumns} data={productRank} emptyText="暂无数据" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">顾客消费 TOP 10</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable columns={rankColumns} data={customerRank} emptyText="暂无数据" />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

// ─── 主组件 ─────────────────────────────────────────────────

interface DataCenterPageProps {
  stores: Array<{ storeId: string; storeName: string }>
}

export default function DataCenterPageClient({ stores }: DataCenterPageProps) {
  const [filter, setFilter] = useState<DateFilter>({})

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-[var(--foreground)]">数据中心</h1>

      <Tabs defaultValue="return-rate">
        <TabsList>
          <TabsTrigger value="return-rate">客户回店率</TabsTrigger>
          <TabsTrigger value="category-ratio">品项占比</TabsTrigger>
          <TabsTrigger value="flow">经营动线</TabsTrigger>
          <TabsTrigger value="efficiency">人效分析</TabsTrigger>
          <TabsTrigger value="ranking">排行榜</TabsTrigger>
        </TabsList>

        <TabsContent value="return-rate">
          <ReturnRateTab stores={stores} filter={filter} onChange={setFilter} />
        </TabsContent>

        <TabsContent value="category-ratio">
          <CategoryMixTab stores={stores} filter={filter} onChange={setFilter} />
        </TabsContent>

        <TabsContent value="flow">
          <FunnelTab stores={stores} filter={filter} onChange={setFilter} />
        </TabsContent>

        <TabsContent value="efficiency">
          <EfficiencyTab stores={stores} filter={filter} onChange={setFilter} />
        </TabsContent>

        <TabsContent value="ranking">
          <RankingTab stores={stores} filter={filter} onChange={setFilter} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

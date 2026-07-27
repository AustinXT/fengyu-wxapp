import { metricGroups } from "@/lib/metric-catalog"

export default function KnowledgePage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-950">指标知识库</h1>
        <p className="mt-1 text-sm text-neutral-500">复购率、普及率、新客漏斗口径</p>
      </div>

      <section className="rounded-lg border border-[var(--border)] bg-white p-5">
        <h2 className="text-base font-semibold text-neutral-950">指标目录</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {metricGroups.map((group) => (
            <div key={group.id} className="rounded-md border border-[var(--border)] p-3">
              <div className="text-sm font-medium text-neutral-950">{group.label}</div>
              <div className="mt-3 space-y-2">
                {group.metrics.map((metric) => (
                  <div key={metric.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-neutral-700">{metric.label}</span>
                    <span className="shrink-0 text-xs text-neutral-400">
                      {metric.status === "available" ? "已接入" : "预留"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-white p-5">
        <h2 className="text-base font-semibold text-neutral-950">核心公式</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-md bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-800">
            复购率 = 复购人数 / 品项进入总人数
          </div>
          <div className="rounded-md bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-800">
            普及率 = 持卡会员数 / 总会员数
          </div>
          <div className="rounded-md bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-800">
            新客到店率 = T+90 到店人数 / 新客总人数
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-md border border-[var(--border)] p-3">
            <div className="text-sm font-medium text-neutral-950">品项进入</div>
            <p className="mt-2 text-sm leading-6 text-neutral-600">
              同一顾客、同一天、同门店、同一级品项、同二级品项购买合并后，received 累计净实收达到系统会员门槛。
            </p>
          </div>
          <div className="rounded-md border border-[var(--border)] p-3">
            <div className="text-sm font-medium text-neutral-950">复购</div>
            <p className="mt-2 text-sm leading-6 text-neutral-600">
              筛选区间内首次进入后，后续非同日再次达标购买；与首次进入同一天的新开卡项不算复购。
            </p>
          </div>
          <div className="rounded-md border border-[var(--border)] p-3">
            <div className="text-sm font-medium text-neutral-950">门槛</div>
            <p className="mt-2 text-sm leading-6 text-neutral-600">
              从 system_configs.new_member_threshold 读取，缺失时使用 1980 元兜底。
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-white p-5">
        <h2 className="text-base font-semibold text-neutral-950">数据来源</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-[var(--border)] text-xs text-neutral-500">
              <tr>
                <th className="py-2 font-medium">业务含义</th>
                <th className="py-2 font-medium">新库来源</th>
                <th className="py-2 font-medium">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] text-neutral-700">
              <tr>
                <td className="py-3">顾客</td>
                <td className="py-3">sale_orders.client_user_id</td>
                <td className="py-3">关联 client_wechat_users 展示姓名和顾客编号。</td>
              </tr>
              <tr>
                <td className="py-3">品项</td>
                <td className="py-3">product_skus → product_categories</td>
                <td className="py-3">同时使用 product_kind 和 category_name，两个字段共同定义一个品项。</td>
              </tr>
              <tr>
                <td className="py-3">金额</td>
                <td className="py-3">sale_items.received</td>
                <td className="py-3">使用行级累计净实收，回款已累计到该字段，不再另查回款流水。</td>
              </tr>
              <tr>
                <td className="py-3">日期</td>
                <td className="py-3">sale_orders.sale_order_datetime / paid_at</td>
                <td className="py-3">优先按订单消费日期归属，缺失时回落到付款时间。</td>
              </tr>
              <tr>
                <td className="py-3">范围</td>
                <td className="py-3">当前登录员工组织 scope</td>
                <td className="py-3">市场和门店筛选在服务端叠加权限范围。</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-white p-5">
        <h2 className="text-base font-semibold text-neutral-950">计算步骤</h2>
        <ol className="mt-4 space-y-3 text-sm leading-6 text-neutral-700">
          <li>1. 读取销售单和转换单的购买明细，排除已关闭、已作废、未审核、待审批、支付失败订单，过滤空品项、无顾客、无消费日期的数据。</li>
          <li>2. 按顾客、自然日、门店、一级品项、二级品项合并购买金额，解决同日拆单带来的重复计数。</li>
          <li>3. 只保留合并后净实收达到门槛的达标日。</li>
          <li>4. 按顾客、一级品项、二级品项取截至筛选结束日的最早达标日，并要求该进入日期落在筛选区间内。</li>
          <li>5. 若本期进入顾客在筛选区间内存在晚于进入日期的达标日，则计入复购人数。</li>
        </ol>
      </section>
    </div>
  )
}

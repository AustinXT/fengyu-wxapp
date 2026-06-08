"use client";

import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { StatusBadge, Badge } from "@/components/ui/badge";
import { formatPhone, formatDate, formatDateTime } from "@/lib/utils";
import type { CardDetail, CardTransaction } from "@/actions/cards";
import { computeCardStatus, STATUS_LABEL_MAP, TYPE_BADGE_MAP } from "../_lib/card-status";

function formatMoney(v: string | null | undefined): string {
	if (v === null || v === undefined) return "—";
	const n = Number(v);
	if (!Number.isFinite(n)) return "—";
	return `¥${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateOrDash(s: string | null | undefined): string {
	if (!s) return "—";
	return formatDate(s);
}

function formatDateTimeOrDash(s: string | null | undefined): string {
	if (!s) return "—";
	return formatDateTime(s);
}

function cardTypeLabel(sessionCount: number | null): "疗程卡" | "单次卡" | null {
	if (sessionCount === null) return null;
	if (sessionCount === 1) return "单次卡";
	return "疗程卡";
}

export default function CardDetailPageClient({
	card,
	transactions,
	canSeeOrderLink,
}: {
	card: CardDetail;
	transactions: CardTransaction[];
	canSeeOrderLink: boolean;
}) {
	const status = computeCardStatus(card);
	const statusMeta = STATUS_LABEL_MAP[status];
	const typeLabel = cardTypeLabel(card.sessionCount);
	const used =
		card.sessionCount !== null
			? card.sessionCount - (card.remainingSessions ?? 0)
			: null;

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-3">
				<Link
					href="/cards"
					className="text-[#999999] hover:text-[var(--foreground)]"
					aria-label="返回疗程卡列表"
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						<polyline points="15 18 9 12 15 6" />
					</svg>
				</Link>
				<h1 className="text-2xl font-bold text-[var(--foreground)]">疗程卡详情</h1>
			</div>

			{/* 卡基本信息 */}
			<Card>
				<CardHeader className="flex flex-row items-center justify-between">
					<CardTitle>卡基本信息</CardTitle>
					<div className="flex items-center gap-2">
						{typeLabel && (
							<Badge variant="outline" className={TYPE_BADGE_MAP[typeLabel]}>
								{typeLabel}
							</Badge>
						)}
						<Badge variant="outline" className={statusMeta.className}>
							{statusMeta.label}
						</Badge>
					</div>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-2 md:grid-cols-3 gap-y-4 gap-x-8 text-sm">
						<div>
							<span className="text-[#999999]">卡 ID</span>
							<p className="font-medium mt-1 font-mono text-xs">{card.saleItemId}</p>
						</div>
						<div>
							<span className="text-[#999999]">商品名称</span>
							<p className="font-medium mt-1">{card.productName || "—"}</p>
						</div>
						<div>
							<span className="text-[#999999]">规格</span>
							<p className="font-medium mt-1">{card.productName || "—"}</p>
						</div>
						<div>
							<span className="text-[#999999]">总次数</span>
							<p className="font-medium mt-1">{card.sessionCount ?? "—"}</p>
						</div>
						<div>
							<span className="text-[#999999]">已用</span>
							<p className="font-medium mt-1">{used ?? "—"}</p>
						</div>
						<div>
							<span className="text-[#999999]">剩余</span>
							<p className="font-medium mt-1">{card.remainingSessions ?? "—"}</p>
						</div>
						<div>
							<span className="text-[#999999]">已支付次数</span>
							<p className="font-medium mt-1">{card.paidSessions ?? "—"}</p>
						</div>
						<div>
							<span className="text-[#999999]">单次标价</span>
							<p className="font-medium mt-1">{formatMoney(card.unitPrice)}</p>
						</div>
						<div>
							<span className="text-[#999999]">单次优惠后价</span>
							<p className="font-medium mt-1">{formatMoney(card.unitRealPrice)}</p>
						</div>
						<div>
							<span className="text-[#999999]">行应付总额</span>
							<p className="font-medium mt-1">{formatMoney(card.saleAmount)}</p>
						</div>
						<div>
							<span className="text-[#999999]">行实收</span>
							<p className="font-medium mt-1">{formatMoney(card.received)}</p>
						</div>
						<div>
							<span className="text-[#999999]">有效期</span>
							<p className="font-medium mt-1">{formatDateOrDash(card.expireDate)}</p>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* 顾客与门店 */}
			<Card>
				<CardHeader>
					<CardTitle>顾客与门店</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-2 md:grid-cols-4 gap-y-4 gap-x-8 text-sm">
						<div>
							<span className="text-[#999999]">顾客姓名</span>
							<p className="font-medium mt-1">{card.clientName || "—"}</p>
						</div>
						<div>
							<span className="text-[#999999]">手机号</span>
							<p className="font-medium mt-1">{card.clientPhone ? formatPhone(card.clientPhone) : "—"}</p>
						</div>
						<div>
							<span className="text-[#999999]">门店</span>
							<p className="font-medium mt-1">{card.storeName || "—"}</p>
						</div>
						<div>
							<span className="text-[#999999]">市场</span>
							<p className="font-medium mt-1">{card.marketName || "—"}</p>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* 关联订单 */}
			<Card>
				<CardHeader>
					<CardTitle>关联订单</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-2 md:grid-cols-4 gap-y-4 gap-x-8 text-sm">
						<div>
							<span className="text-[#999999]">订单号</span>
							<p className="font-medium mt-1">
								{canSeeOrderLink ? (
									<Link
										href={`/orders/${card.saleOrderId}`}
										className="text-[var(--primary)] hover:underline"
									>
										{card.saleOrderId}
									</Link>
								) : (
									<span className="font-mono text-xs">{card.saleOrderId}</span>
								)}
							</p>
						</div>
						<div>
							<span className="text-[#999999]">订单状态</span>
							<p className="mt-1">
								{card.orderStatus ? <StatusBadge status={card.orderStatus} /> : "—"}
							</p>
						</div>
						<div>
							<span className="text-[#999999]">开单时间</span>
							<p className="font-medium mt-1">{formatDateTimeOrDash(card.orderCreatedAt)}</p>
						</div>
						<div>
							<span className="text-[#999999]">付款时间</span>
							<p className="font-medium mt-1">{formatDateTimeOrDash(card.paidAt)}</p>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* 划卡明细 */}
			<Card>
				<CardHeader>
					<CardTitle>划卡明细</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead className="bg-gray-50 sticky top-0">
								<tr>
									<th className="px-4 py-3 text-left font-medium text-gray-500">服务日期</th>
									<th className="px-4 py-3 text-left font-medium text-gray-500">服务单号</th>
									<th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
									<th className="px-4 py-3 text-left font-medium text-gray-500">操作员工</th>
									<th className="px-4 py-3 text-right font-medium text-gray-500">本次划次数</th>
									<th className="px-4 py-3 text-right font-medium text-gray-500">单次价快照</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-gray-200">
								{transactions.length > 0 ? (
									transactions.map((t) => (
										<tr key={t.serviceItemId} className="hover:bg-[#FFF0EE] transition-colors">
											<td className="px-4 py-3">{formatDateOrDash(t.serviceDate)}</td>
											<td className="px-4 py-3 font-medium">
												<Link
													href={`/services/${t.serviceOrderId}`}
													className="text-[var(--primary)] hover:underline"
												>
													{t.serviceOrderId}
												</Link>
											</td>
											<td className="px-4 py-3">
												<StatusBadge status={t.serviceOrderStatus} />
											</td>
											<td className="px-4 py-3">{t.employeeName || "—"}</td>
											<td className="px-4 py-3 text-right">{t.sessionUsed}</td>
											<td className="px-4 py-3 text-right">{formatMoney(t.unitRealPriceSnapshot)}</td>
										</tr>
									))
								) : (
									<tr>
										<td colSpan={6} className="px-4 py-8 text-center text-[#999999]">
											暂无划卡记录
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}

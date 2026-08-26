"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useUrlFilters } from "@/lib/hooks/use-url-filters";
import { PreserveListContextLink } from "@/components/return-context";
import { type AdminCard, type CardFilterOptions } from "@/actions/cards";
import { ExportButton } from "@/components/ui/export-button";
import type { MarketStoreFilterOptions } from "@/lib/market-store-filter-types";
import MarketStoreFilter from "@/components/market-store-filter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Pagination } from "@/components/ui/pagination";
import { formatPhone, formatDate } from "@/lib/utils";
import { computeCardStatus, STATUS_LABEL_MAP, TYPE_BADGE_MAP } from "../_lib/card-status";

const PAGE_SIZE_OPTIONS = [10, 20, 50];

type CardTypeValue = "" | "all" | "疗程卡" | "单次卡";
type CardStatusValue = "" | "active" | "exhausted" | "expired";

function formatMoney(value: number): string {
	return `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface Props {
	cards: AdminCard[];
	filterOptions: MarketStoreFilterOptions;
	cardFilterOptions: CardFilterOptions;
	total: number;
}

/**
 * 疗程卡管理页 — 服务端分页
 *
 * 卡包定义：sale_items WHERE product_type='疗程卡' AND item_direction='购买' AND remaining_sessions IS NOT NULL
 * 类型徽章：session_count=1 → 单次卡；>=2 → 疗程卡
 */
export default function CardsPage({ cards, filterOptions, cardFilterOptions, total }: Props) {
	const { get, set, setMany } = useUrlFilters();
	const setFilter = useCallback(
		(key: string, value: string) => {
			setMany({ [key]: value, page: "" });
		},
		[setMany],
	);

	const marketFilter = get("market");
	const storeFilter = get("store");
	const typeFilter = (get("type") as CardTypeValue) || "";
	const statusFilter = (get("status") as CardStatusValue) || "";
	const productKindFilter = get("productKind");
	const categoryFilter = get("category");
	const currentPage = Math.max(1, Number(get("page", "1")) || 1);
	const pageSize = PAGE_SIZE_OPTIONS.includes(Number(get("size"))) ? Number(get("size")) : 20;
	const categoryOptions = cardFilterOptions.categories.filter(
		(category) => !productKindFilter || category.productKind === productKindFilter,
	);

	// 搜索防抖 300ms
	const [searchInput, setSearchInput] = useState(get("q"));
	const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null);
	const handleSearchChange = useCallback(
		(value: string) => {
			setSearchInput(value);
			if (debounceRef[0]) clearTimeout(debounceRef[0]);
			debounceRef[0] = setTimeout(() => setFilter("q", value), 300);
		},
		[setFilter, debounceRef],
	);

	const searchParams = useSearchParams();

	const columns: Column<AdminCard>[] = [
		{
			key: "client",
			header: "顾客",
			cell: (row) => (
				<div className="flex flex-col">
					{row.clientUserId ? (
						<Link href={`/customers/${row.clientUserId}`} className="font-medium hover:underline">
							{row.clientName ?? "—"}
						</Link>
					) : (
						<span>{row.clientName ?? "—"}</span>
					)}
					{row.clientPhone && <span className="text-xs text-[#999999]">{formatPhone(row.clientPhone)}</span>}
				</div>
			),
		},
		{
			key: "product",
			header: "商品/规格",
			cell: (row) => (
				<div className="flex flex-col">
					<PreserveListContextLink
						href={`/cards/${row.saleItemId}`}
						className="line-clamp-1 font-medium text-[var(--primary)] hover:underline"
					>
						{row.productName ?? "—"}
					</PreserveListContextLink>
				</div>
			),
		},
		{
			key: "typeBadge",
			header: "类型",
			cell: (row) => {
				// B2 兜底：单次卡若历史行 quantity>1（未拆历史数据），显示"单次卡 ×N"
				// 新行（修写入侧后）quantity 恒 = 1，labelKey 走"单次卡"分支即可
				// ticket: notes/tickets/archives/2026-05-18-single-session-card-quantity-not-split.md
				const sessionCount = row.sessionCount ?? 0;
				const unit = row.unit || "次";
				const labelKey = sessionCount === 1 ? "单次卡" : "疗程卡";
				const label =
					sessionCount === 1
						? `单${unit}卡${row.quantity > 1 ? ` ×${row.quantity}` : ""}`
						: `${sessionCount}${unit}卡`;
				return (
					<Badge variant="outline" className={TYPE_BADGE_MAP[labelKey] ?? ""}>
						{label}
					</Badge>
				);
			},
		},
		{
			key: "remaining",
			header: "剩余 / 已付 / 总量",
			cell: (row) => {
				const total = row.sessionCount ?? 0;
				const remaining = row.paidUnusedSessions ?? 0;
				const paid = row.paidSessions ?? 0;
				const ratio = total > 0 ? remaining / total : 0;
				const barColor = ratio === 0 ? "bg-[#D94040]" : ratio < 0.3 ? "bg-[#D4820A]" : "bg-[#3D8A5A]";
				return (
					<div className="flex flex-col gap-1">
						<span className="text-sm font-medium">
							{remaining} / {paid} / {total} {row.unit}
						</span>
						<div className="h-1 w-20 overflow-hidden rounded bg-[#F0F0F0]">
							<div className={`h-full ${barColor}`} style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
						</div>
					</div>
				);
			},
		},
		{
			key: "remainingRemainder",
			header: "剩余零头",
			cell: (row) => <span className="text-sm">{formatMoney(row.remainingRemainder)}</span>,
		},
		{
			key: "storeMarket",
			header: "购买门店",
			cell: (row) => (
				<div className="flex flex-col text-sm">
					<span>{row.storeName ?? "—"}</span>
					{row.marketName && <span className="text-xs text-[#999999]">{row.marketName}</span>}
				</div>
			),
		},
		{
			key: "paidAt",
			header: "购买时间",
			cell: (row) => <span className="text-xs text-[#666666]">{formatDate(row.paidAt) || "—"}</span>,
		},
		{
			key: "expireDate",
			header: "有效期",
			cell: (row) =>
				row.expireDate ? (
					<span className="text-xs text-[#666666]">{formatDate(row.expireDate)}</span>
				) : (
					<span className="text-xs text-[#999999]">永久</span>
				),
		},
		{
			key: "status",
			header: "状态",
			cell: (row) => {
				const s = computeCardStatus(row);
				const meta = STATUS_LABEL_MAP[s];
				return (
					<Badge variant="outline" className={meta.className}>
						{meta.label}
					</Badge>
				);
			},
		},
	];

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold text-[var(--foreground)]">疗程卡管理</h1>
			</div>

			<Card>
				<CardContent className="p-4">
					<div className="flex flex-wrap items-center gap-3">
						<MarketStoreFilter
							options={filterOptions}
							marketValue={marketFilter}
							storeValue={storeFilter}
							onMarketChange={(value) => setMany({ market: value, store: "", page: "" })}
							onStoreChange={(value) => setFilter("store", value)}
						/>

						{/* Segmented: 卡类型 */}
						<div className="flex rounded-md border border-[var(--border)] bg-white p-0.5 text-sm">
							{[
								{ value: "", label: "全部" },
								{ value: "疗程卡", label: "疗程卡" },
								{ value: "单次卡", label: "单次卡" },
							].map((opt) => {
								const isActive = typeFilter === opt.value || (opt.value === "" && !typeFilter);
								return (
									<Button
										key={opt.value}
										type="button"
										variant={isActive ? "default" : "ghost"}
										size="sm"
										className="h-7 px-3"
										onClick={() => setFilter("type", opt.value)}
									>
										{opt.label}
									</Button>
								);
							})}
						</div>

							<Select value={statusFilter} onChange={(e) => setFilter("status", e.target.value)} className="w-32">
								<option value="">全部状态</option>
							<option value="active">有效</option>
							<option value="exhausted">已耗尽</option>
							<option value="expired">已过期</option>
							</Select>

							<Select
								value={productKindFilter}
								onChange={(e) => setMany({ productKind: e.target.value, category: "", page: "" })}
								className="w-36"
							>
								<option value="">全部一级品项</option>
								{cardFilterOptions.productKinds.map((productKind) => (
									<option key={productKind} value={productKind}>{productKind}</option>
								))}
							</Select>

							<Select
								value={categoryFilter}
								onChange={(e) => setFilter("category", e.target.value)}
								className="w-36"
								disabled={!productKindFilter}
							>
								<option value="">{productKindFilter ? "全部二级品项" : "请先选择一级品项"}</option>
								{categoryOptions.map((category) => (
									<option key={category.categoryId} value={category.categoryId}>{category.categoryName}</option>
								))}
							</Select>

							<Input
								placeholder="搜索疗程卡名称 / 姓名 / 手机号 / 订单号"
							value={searchInput}
							onChange={(e) => handleSearchChange(e.target.value)}
							className="max-w-xs"
						/>
						<ExportButton
							exportRequest={{
								exportType: "cards",
								payload: Object.fromEntries(searchParams.entries()),
							}}
						/>
					</div>
				</CardContent>
			</Card>

			<DataTable columns={columns} data={cards} />

			<Pagination
				total={total}
				pageSize={pageSize}
				page={currentPage}
				onPageChange={(p) => set("page", p === 1 ? "" : String(p))}
				pageSizeOptions={PAGE_SIZE_OPTIONS}
				onPageSizeChange={(size) => setMany({ size: String(size), page: "" })}
			/>
		</div>
	);
}

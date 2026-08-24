import { notFound } from "next/navigation";
import { getCardById, getCardTransactions } from "@/actions/cards";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { requireUiPageCapability } from '@/lib/page-capability'
import CardDetailPageClient from "../_components/card-detail-page";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const session = await getSession();
	requireUiPageCapability(session, 'sale_item:list')

	// 关联订单链接：仅当账号能进 /orders 详情时渲染链接，否则纯文本订单号
	// （customer_mgr 有 sale_item:list 但无 sale_order:list，跳进去会被 getOrderById 拒）
	const canSeeOrderLink = !!(session && hasPermission(session, "sale_order:list"));

	const [card, transactions] = await Promise.all([
		getCardById(id),
		getCardTransactions(id),
	]);

	if (!card) notFound();

	return (
		<CardDetailPageClient
			card={card}
			transactions={transactions}
			canSeeOrderLink={canSeeOrderLink}
		/>
	);
}

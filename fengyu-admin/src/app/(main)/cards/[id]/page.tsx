import { notFound } from "next/navigation";
import { getCardById, getCardTransactions } from "@/actions/cards";
import { getSession } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import CardDetailPageClient from "../_components/card-detail-page";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const session = await getSession();

	
	
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

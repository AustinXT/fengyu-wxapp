
export type CardStatus = "active" | "exhausted" | "expired";

export function computeCardStatus(row: {
	expireDate: string | null;
	remainingSessions: number | null;
}): CardStatus {
	if (row.expireDate) {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const exp = new Date(row.expireDate);
		if (exp < today) return "expired";
	}
	if ((row.remainingSessions ?? 0) === 0) return "exhausted";
	return "active";
}

export const STATUS_LABEL_MAP: Record<CardStatus, { label: string; className: string }> = {
	active: { label: "有效", className: "border-[#3D8A5A] text-[#3D8A5A] bg-[#F0F9F2]" },
	exhausted: { label: "已耗尽", className: "border-[#888888] text-[#888888] bg-[#F5F5F5]" },
	expired: { label: "已过期", className: "border-[#D94040] text-[#D94040] bg-[#FFF0F0]" },
};

export const TYPE_BADGE_MAP: Record<string, string> = {
	疗程卡: "border-[#888888] text-[#888888] bg-[#F5F5F5]",
	单次卡: "border-[#D4820A] text-[#D4820A] bg-[#FFF8E6]",
};

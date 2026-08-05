const MEMBER_LEVEL_BADGE_CLASS: Record<string, string> = {
  黑钻: 'member-level-badge--black',
  金钻: 'member-level-badge--gold',
  粉钻: 'member-level-badge--pink',
  星钻: 'member-level-badge--blue',
  初钻: 'member-level-badge--green',
};

export interface MemberLevelBadgeData {
  memberLevelBadgeClass: string;
}

export function getMemberLevelBadgeClass(memberLevel?: string | null): string {
  if (!memberLevel) return 'member-level-badge--default';
  return MEMBER_LEVEL_BADGE_CLASS[memberLevel] || 'member-level-badge--default';
}

export function withMemberLevelBadgeClass<T extends { memberLevel?: string | null }>(
  item: T,
): T & MemberLevelBadgeData {
  return {
    ...item,
    memberLevelBadgeClass: getMemberLevelBadgeClass(item.memberLevel),
  };
}

export function withMemberLevelBadgeClasses<T extends { memberLevel?: string | null }>(
  list: T[],
): Array<T & MemberLevelBadgeData> {
  return list.map(withMemberLevelBadgeClass);
}

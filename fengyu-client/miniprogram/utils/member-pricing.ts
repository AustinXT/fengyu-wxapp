/**
 * 会员价分流展示 helper（前端）—— 与后端 clientApi/utils/member-pricing.js 同口径。
 *
 * 「仅会员看会员价划线、非会员只看标价」。会员身份由 app.setMemberFlag 写入 storage('isMember')
 * （后端 auth.login 权威 isMember；刷新点：onLaunch.syncLoginState / 绑定门店后 / 个人中心 onShow）；
 * 体验卡（is_experience）同口径（#6=B，不再豁免，会员才享会员价）。
 * 会员价须严格 < 标价才划线（脏数据 guard）。
 *
 * 注意：这是展示层；实际结算价以云函数 order.create 为权威。
 */

/** 当前登录顾客是否会员（读 app 写入的 storage） */
export function getIsMember(): boolean {
  return !!wx.getStorageSync('isMember');
}

export interface PriceView {
  /** 实际展示的主价（会员价或标价） */
  display: number;
  /** 划线价（标价）；null = 不划线 */
  strike: number | null;
}

/**
 * 计算某 SKU 对当前顾客的展示价对。
 * @param isMember 是否会员
 * @param special  会员价（special_price，可空）
 * @param list     标价（price）
 * @param isExperience 是否体验卡（#6=B 起不再豁免；保留入参兼容旧调用，不再参与分流判定）
 */
export function priceView(
  isMember: boolean,
  special: number | string | null | undefined,
  list: number | string | null | undefined,
  isExperience = false,
): PriceView {
  const l = Number(list) || 0;
  const s = special === null || special === undefined || special === '' ? null : Number(special);
  // 会员价分流（#6=B：体验卡不再豁免，与普通单品同口径）；isExperience 入参保留仅为兼容旧调用方
  void isExperience;
  const eligible = isMember;
  if (eligible && s !== null && s < l) {
    return { display: s, strike: l };
  }
  return { display: l, strike: null };
}




export function getIsMember(): boolean {
  return !!wx.getStorageSync('isMember');
}

export interface PriceView {
  
  display: number;
  
  strike: number | null;
}


export function priceView(
  isMember: boolean,
  special: number | string | null | undefined,
  list: number | string | null | undefined,
  isExperience = false,
): PriceView {
  const l = Number(list) || 0;
  const s = special === null || special === undefined || special === '' ? null : Number(special);
  
  void isExperience;
  const eligible = isMember;
  if (eligible && s !== null && s < l) {
    return { display: s, strike: l };
  }
  return { display: l, strike: null };
}

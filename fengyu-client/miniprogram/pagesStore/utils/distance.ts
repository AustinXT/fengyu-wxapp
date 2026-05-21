// pagesStore/utils/distance.ts — 距离计算与地址拼装

/**
 * Haversine 球面距离，返回千米
 */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // 地球半径（千米）
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 距离格式化：>=1km 显示「X.X千米」，<1km 显示「XXX米」
 */
export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)}米`;
  return `${km.toFixed(1)}千米`;
}

/**
 * 拼装「省市区+地址」：district 存为 "省/市/区" 斜杠串，去斜杠后接街道
 */
export function formatStoreAddress(district?: string | null, street?: string | null): string {
  const region = (district || '').replace(/\//g, '');
  return `${region}${street || ''}`.trim();
}




export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; 
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)}米`;
  return `${km.toFixed(1)}千米`;
}


export function formatStoreAddress(district?: string | null, street?: string | null): string {
  const region = (district || '').replace(/\//g, '');
  return `${region}${street || ''}`.trim();
}

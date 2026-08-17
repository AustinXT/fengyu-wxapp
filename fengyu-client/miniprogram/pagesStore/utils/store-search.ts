export const MIN_STORE_SEARCH_LENGTH = 2;

export interface StoreSearchCandidate {
  store_name?: string | null;
  market_name?: string | null;
  store_region?: string | null;
}

function normalizeText(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

export function getStoreSearchLength(keyword: string): number {
  return Array.from(normalizeText(keyword)).length;
}

export function searchStores<T extends StoreSearchCandidate>(stores: T[], keyword: string): T[] {
  const normalized = normalizeText(keyword);
  if (Array.from(normalized).length < MIN_STORE_SEARCH_LENGTH) return [];

  return stores.filter((store) => [
    store.store_name,
    store.market_name,
    store.store_region,
  ].some((field) => normalizeText(field).includes(normalized)));
}

export function filterStoresByCity<T extends StoreSearchCandidate>(stores: T[], city: string): T[] {
  const normalizedCity = normalizeText(city).replace(/市$/, '');
  if (!normalizedCity) return [];

  return stores.filter((store) => [store.store_region, store.market_name]
    .some((field) => normalizeText(field).includes(normalizedCity)));
}

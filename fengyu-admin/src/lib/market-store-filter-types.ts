export interface MarketFilterOption {
  marketId: string
  marketName: string
}

export interface StoreFilterOption {
  storeId: string
  storeName: string
  marketId: string | null
  marketName: string | null
}

export interface MarketStoreFilterOptions {
  markets: MarketFilterOption[]
  stores: StoreFilterOption[]
}

import {
  MIN_STORE_SEARCH_LENGTH,
  filterStoresByCity,
  getStoreSearchLength,
  searchStores,
} from '../../../pagesStore/utils/store-search'

const stores = [
  {
    store_id: 'nc-1',
    store_name: '红谷滩旗舰店',
    market_name: '南昌市场',
    store_region: '江西省/南昌市/红谷滩区',
  },
  {
    store_id: 'jj-1',
    store_name: '万达店',
    market_name: '九江市场',
    store_region: '江西省/九江市/濂溪区',
  },
  {
    store_id: 'gz-1',
    store_name: 'Tianhe Beauty',
    market_name: '广州市场',
    store_region: '广东省/广州市/天河区',
  },
]

describe('门店全局检索', () => {
  test('去除首尾空格并按 Unicode 字符计数', () => {
    expect(MIN_STORE_SEARCH_LENGTH).toBe(2)
    expect(getStoreSearchLength('  南昌  ')).toBe(2)
    expect(getStoreSearchLength(' 店 ')).toBe(1)
  })

  test('少于 2 个字时不返回宽泛结果', () => {
    expect(searchStores(stores, '店')).toEqual([])
    expect(searchStores(stores, '  ')).toEqual([])
  })

  test('可按门店名、市场名和省市区跨城市匹配', () => {
    expect(searchStores(stores, '旗舰').map((store) => store.store_id)).toEqual(['nc-1'])
    expect(searchStores(stores, '九江').map((store) => store.store_id)).toEqual(['jj-1'])
    expect(searchStores(stores, '天河').map((store) => store.store_id)).toEqual(['gz-1'])
  })

  test('英文检索不区分大小写', () => {
    expect(searchStores(stores, 'BEAUTY').map((store) => store.store_id)).toEqual(['gz-1'])
  })
})

describe('定位城市推荐', () => {
  test('空关键词时可按区域或市场名恢复当前城市门店', () => {
    expect(filterStoresByCity(stores, '南昌').map((store) => store.store_id)).toEqual(['nc-1'])
    expect(filterStoresByCity(stores, '九江市').map((store) => store.store_id)).toEqual(['jj-1'])
  })

  test('城市为空时不默认展示全部门店', () => {
    expect(filterStoresByCity(stores, '')).toEqual([])
  })
})

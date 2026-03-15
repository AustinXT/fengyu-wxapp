/**
 * 格式化工具函数测试
 */
import {
  maskPhone,
  formatDate,
  formatDiscount,
  calculateProgress,
  cleanErrorMessage,
  calculateTotal,
  searchProducts,
  getStatusClass,
  formatOrderDate,
  formatDateTime,
  formatShortDate,
  formatRelativeTime,
  formatAmount,
} from '../../utils/format'

describe('maskPhone', () => {
  test('标准 11 位手机号', () => {
    expect(maskPhone('13812345678')).toBe('138****5678')
  })
  test('空字符串', () => {
    expect(maskPhone('')).toBe('')
  })
  test('短于 7 位原样返回', () => {
    expect(maskPhone('123456')).toBe('123456')
  })
  test('正好 7 位', () => {
    expect(maskPhone('1234567')).toBe('123****4567')
  })
})

describe('formatDate', () => {
  test('ISO 日期格式化', () => {
    expect(formatDate('2025-03-14T10:00:00Z')).toBe('2025-03-14')
  })
  test('补零：个位月和日', () => {
    expect(formatDate('2025-01-05')).toBe('2025-01-05')
  })
  test('空字符串', () => {
    expect(formatDate('')).toBe('')
  })
  test('无效日期', () => {
    expect(formatDate('not-a-date')).toBe('')
  })
})

describe('formatDiscount', () => {
  test('折扣券：0.8 → "8折"', () => {
    expect(formatDiscount({ couponType: '折扣券', discountValue: 0.8 })).toBe('8折')
  })
  test('折扣券：0.75 → "8折"（四舍五入）', () => {
    expect(formatDiscount({ couponType: '折扣券', discountValue: 0.75 })).toBe('8折')
  })
  test('现金券：10 → "¥10"', () => {
    expect(formatDiscount({ couponType: '现金券', discountValue: 10 })).toBe('¥10')
  })
  test('项目券：50 → "¥50"', () => {
    expect(formatDiscount({ couponType: '项目券', discountValue: 50 })).toBe('¥50')
  })
  test('字符串数值', () => {
    expect(formatDiscount({ couponType: '现金券', discountValue: '20' })).toBe('¥20')
  })
})

describe('calculateProgress', () => {
  test('已用 2/10 → 20%', () => {
    expect(calculateProgress(10, 8)).toBe(20)
  })
  test('全部用完 → 100%', () => {
    expect(calculateProgress(5, 0)).toBe(100)
  })
  test('未使用 → 0%', () => {
    expect(calculateProgress(10, 10)).toBe(0)
  })
  test('sessionCount=0 → 0%', () => {
    expect(calculateProgress(0, 0)).toBe(0)
  })
  test('负数 sessionCount → 0%', () => {
    expect(calculateProgress(-1, 0)).toBe(0)
  })
  test('四舍五入：1/3 → 33%', () => {
    expect(calculateProgress(3, 2)).toBe(33)
  })
})

describe('cleanErrorMessage', () => {
  test('移除 INVALID_PARAMS 前缀', () => {
    expect(cleanErrorMessage('INVALID_PARAMS: 缺少参数')).toBe('缺少参数')
  })
  test('移除 UNAUTHORIZED 前缀', () => {
    expect(cleanErrorMessage('UNAUTHORIZED: 未登录')).toBe('未登录')
  })
  test('无前缀原样返回', () => {
    expect(cleanErrorMessage('网络异常')).toBe('网络异常')
  })
  test('空字符串 → 默认消息', () => {
    expect(cleanErrorMessage('')).toBe('请求失败')
  })
})

describe('calculateTotal', () => {
  test('空数组 → 0', () => {
    expect(calculateTotal([])).toBe(0)
  })
  test('单个商品', () => {
    expect(calculateTotal([{ price: 99.9, quantity: 2 }])).toBe(199.8)
  })
  test('多个商品', () => {
    expect(calculateTotal([
      { price: 100, quantity: 2 },
      { price: 50, quantity: 3 },
    ])).toBe(350)
  })
  test('浮点精度：0.1+0.2 场景', () => {
    const total = calculateTotal([{ price: 0.1, quantity: 1 }, { price: 0.2, quantity: 1 }])
    expect(total).toBe(0.3)
  })
})

describe('searchProducts', () => {
  const cache = {
    'cat-1': [
      { product_id: 'p1', name: '美白护理' },
      { product_id: 'p2', name: '补水护理' },
    ],
    'cat-2': [
      { product_id: 'p3', name: '美白面膜' },
      { product_id: 'p1', name: '美白护理' }, // 重复
    ],
  }
  const keys = ['cat-1', 'cat-2']

  test('关键字匹配', () => {
    const results = searchProducts('美白', cache, keys)
    expect(results).toHaveLength(2) // p1 + p3，p1 去重
    expect(results.map(r => r.product_id)).toEqual(['p1', 'p3'])
  })
  test('大小写不敏感', () => {
    const cacheEn = { 'c1': [{ product_id: 'p1', name: 'Whitening Care' }] }
    expect(searchProducts('whitening', cacheEn, ['c1'])).toHaveLength(1)
  })
  test('无匹配', () => {
    expect(searchProducts('不存在', cache, keys)).toHaveLength(0)
  })
  test('空关键字', () => {
    expect(searchProducts('', cache, keys)).toHaveLength(0)
    expect(searchProducts('  ', cache, keys)).toHaveLength(0)
  })
})

describe('getStatusClass', () => {
  test('待支付', () => expect(getStatusClass('待支付')).toBe('status-pending'))
  test('已支付', () => expect(getStatusClass('已支付')).toBe('status-paid'))
  test('已关闭', () => expect(getStatusClass('已关闭')).toBe('status-closed'))
  test('未知状态', () => expect(getStatusClass('未知')).toBe('status-class-done'))
})

describe('formatOrderDate', () => {
  test('标准格式', () => {
    expect(formatOrderDate('2025-03-14T10:00:00Z')).toMatch(/2025-3-14/)
  })
  test('空字符串', () => {
    expect(formatOrderDate('')).toBe('')
  })
  test('无效日期', () => {
    expect(formatOrderDate('invalid')).toBe('')
  })
})

describe('formatDateTime', () => {
  test('ISO 日期时间', () => {
    // 使用本地时间构造以避免时区问题
    const d = new Date(2025, 2, 14, 10, 30); // 2025-03-14 10:30 local
    expect(formatDateTime(d.toISOString())).toBe('2025-03-14 10:30')
  })
  test('补零', () => {
    const d = new Date(2025, 0, 5, 8, 5); // 2025-01-05 08:05 local
    expect(formatDateTime(d.toISOString())).toBe('2025-01-05 08:05')
  })
  test('空字符串', () => {
    expect(formatDateTime('')).toBe('')
  })
  test('无效日期', () => {
    expect(formatDateTime('not-a-date')).toBe('')
  })
})

describe('formatShortDate', () => {
  test('标准 ISO 日期', () => {
    expect(formatShortDate('2025-03-14')).toBe('03-14')
  })
  test('个位月日补零', () => {
    expect(formatShortDate('2025-01-05')).toBe('01-05')
  })
  test('空字符串', () => {
    expect(formatShortDate('')).toBe('')
  })
  test('无效日期', () => {
    expect(formatShortDate('invalid')).toBe('')
  })
})

describe('formatRelativeTime', () => {
  test('刚刚（< 1 分钟）', () => {
    const now = new Date().toISOString()
    expect(formatRelativeTime(now)).toBe('刚刚')
  })
  test('X 分钟前', () => {
    const d = new Date(Date.now() - 5 * 60000).toISOString()
    expect(formatRelativeTime(d)).toBe('5分钟前')
  })
  test('X 小时前', () => {
    const d = new Date(Date.now() - 3 * 3600000).toISOString()
    expect(formatRelativeTime(d)).toBe('3小时前')
  })
  test('X 天前', () => {
    const d = new Date(Date.now() - 2 * 86400000).toISOString()
    expect(formatRelativeTime(d)).toBe('2天前')
  })
  test('超过 7 天显示 MM-DD', () => {
    const d = new Date(Date.now() - 10 * 86400000)
    const expected = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(formatRelativeTime(d.toISOString())).toBe(expected)
  })
  test('空字符串', () => {
    expect(formatRelativeTime('')).toBe('')
  })
})

describe('formatAmount', () => {
  test('正数带 + 号', () => {
    expect(formatAmount(100)).toBe('+100.00')
  })
  test('负数带 - 号', () => {
    expect(formatAmount(-50.5)).toBe('-50.50')
  })
  test('零为正', () => {
    expect(formatAmount(0)).toBe('+0.00')
  })
  test('小数精度', () => {
    expect(formatAmount(9.9)).toBe('+9.90')
  })
})

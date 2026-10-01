/**
 * admin 端内单源 `lib/sales-categories.ts` 的守护（issue #136）
 *
 * 为什么 admin 侧也要有一份：跨端字面量一致性由 staffApi 的
 * `__tests__/routes/sales-categories-enum-snapshot.test.js` 守护，但 admin 的日常自检
 * 只跑 `tsc --noEmit`（见 fengyu-admin/CLAUDE.md）—— 若有人 rename/move 掉本单源、
 * 或把某个消费者改回本地字面量，admin 侧会全绿，要等下次有人跑 staffApi 套件才红。
 * 守护必须在**被拆的那一端**当场失败。
 *
 * 本文件专管两件 staffApi 那边够不着的事：
 *   1. 运行时冻结（词法 snapshot 看不出 `Object.freeze` 有没有真生效）
 *   2. **接线**：`columns.ts` 生成的分类列确实被接进了 `efficiency-staff` 视图配置
 *      —— 词法守护只能证明字面量在文件里，证明不了它被用上。删掉 columns.ts 里那行
 *      `...salesCategoryMetricColumns` 后，页面与导出会丢光 4 个分类列，而
 *      `export-worker/registry.test.ts` 是从**改后的**配置反向生成期望的，它不会红。
 */
import { describe, expect, test } from 'vitest'

import { SALES_CATEGORIES, SALES_CATEGORY_COLUMN_KEYS } from '../sales-categories'
import { DATA_CENTER_VIEW_CONFIG } from '../data-center/columns'
import { DAILY_OVERVIEW_SALES_CATEGORY_ORDER } from '../data-center/daily-overview'

describe('admin sales_category 端内单源', () => {
  test('四值与顺序固定（顺序即下拉与报表列的展示顺序）', () => {
    expect([...SALES_CATEGORIES]).toEqual(['自销自耗', '他销自耗', '他销他耗', '生态合作'])
  })

  test('两个导出常量运行时冻结', () => {
    // `as const` 只有编译期只读；admin 是长驻进程，且 zod 把本数组按引用存进
    // createOrderSchema 的 _def.values，一次 .sort() 会污染下拉顺序与 z.enum 白名单
    expect(Object.isFrozen(SALES_CATEGORIES)).toBe(true)
    expect(Object.isFrozen(SALES_CATEGORY_COLUMN_KEYS)).toBe(true)
  })

  test('每个分类都有列 key，且符合 sale<Camel> 命名约定', () => {
    // staffApi 侧的链路用例靠剥 `sale_` 前缀推导 consume_ 别名，命名跑偏会让那边报错指错方向
    for (const category of SALES_CATEGORIES) {
      const key = SALES_CATEGORY_COLUMN_KEYS[category]
      expect(key, `SALES_CATEGORY_COLUMN_KEYS 缺少「${category}」`).toBeTruthy()
      expect(key, `列 key「${key}」不符合 sale<Camel> 约定`).toMatch(/^sale[A-Z]/)
    }
  })
})

describe('人效表视图确实接入了分类列', () => {
  const config = DATA_CENTER_VIEW_CONFIG['efficiency-staff']

  test('efficiency-staff 是 breakdown 视图', () => {
    expect(config.kind).toBe('breakdown')
  })

  test('4 个分类列存在、同序、key 与单源一致', () => {
    if (config.kind !== 'breakdown') throw new Error('efficiency-staff 不再是 breakdown 视图')

    const categoryLabels = new Set<string>(SALES_CATEGORIES)
    const actual = config.metricColumns.filter((column) => categoryLabels.has(column.label))

    expect(
      actual.map((column) => column.label),
      '人效表缺少分类列或顺序漂移 —— 页面与导出会丢列；若是有意改口径，请连同 staffApi 的链路用例一起显式更新'
    ).toEqual([...SALES_CATEGORIES])

    expect(
      actual.map((column) => column.key),
      '分类列 key 与 SALES_CATEGORY_COLUMN_KEYS 不一致 —— 取数时 row.metrics[key] 会恒 undefined，该列显示为空'
    ).toEqual(SALES_CATEGORIES.map((category) => SALES_CATEGORY_COLUMN_KEYS[category]))

    expect(actual.every((column) => column.unit === 'amount')).toBe(true)
  })
})

describe('日常数据一览表的经营类型展示顺序（#369）', () => {
  // 本页按原型把「他销他耗」排在「他销自耗」前，有意偏离「数组顺序即展示顺序」的约定。
  // 只断言集合相等、不断言顺序：取值仍以 SALES_CATEGORIES 为单源，枚举增删值时这里当场红。
  test('与 SALES_CATEGORIES 集合相等', () => {
    expect([...DAILY_OVERVIEW_SALES_CATEGORY_ORDER].sort()).toEqual([...SALES_CATEGORIES].sort())
  })

  test('运行时冻结', () => {
    expect(Object.isFrozen(DAILY_OVERVIEW_SALES_CATEGORY_ORDER)).toBe(true)
  })
})

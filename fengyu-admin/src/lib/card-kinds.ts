/**
 * 卡类一级 kind 名单 helper（与 staffApi/clientApi 的 product.cardKinds action 行为对齐）
 *
 * 用途：admin 端 Server Component / Server Action 需要按 DB 动态加载的"卡类"
 * 分类名（充值卡 / 体验卡 / 季卡 …），用于开单页 Tab 切换、过滤等场景，
 * 替代代码内 `'充值卡' | '体验卡'` 字面量硬编码。
 *
 * 三端独立维护副本：admin Drizzle 版本 + staffApi/clientApi pg 版本字节同义；
 * 新增卡类（如"季卡"）只需在 DB 加一行 `product_categories` 即可零代码生效。
 */
import { sql } from 'drizzle-orm'
import { db } from '@/db'

export interface CardKind {
  categoryId: string
  categoryName: string
  displayColor: string | null
  displayIcon: string | null
}

/**
 * 取所有"卡类"一级分类（is_card_kind=true 且 productKind IS NULL 且 is_valid=true）
 * 按 sort_order 升序返回，DB 异常时返回空数组（caller 负责前端兜底）。
 */
export async function getCardKindsFromDb(): Promise<CardKind[]> {
  try {
    const rows = await db.execute(sql`
      SELECT category_id, category_name, display_color, display_icon
      FROM product_categories
      WHERE product_kind IS NULL
        AND is_card_kind = true
        AND is_valid = true
      ORDER BY sort_order ASC
    `)
    return (rows as unknown as Array<{
      category_id: string
      category_name: string
      display_color: string | null
      display_icon: string | null
    }>).map((r) => ({
      categoryId: r.category_id,
      categoryName: r.category_name,
      displayColor: r.display_color,
      displayIcon: r.display_icon,
    }))
  } catch {
    return []
  }
}

/**
 * 取所有"卡类"分类名（仅 name 列表）—— 多数 UI 场景只需要名字
 */
export async function getCardKindNamesFromDb(): Promise<string[]> {
  const list = await getCardKindsFromDb()
  return list.map((k) => k.categoryName)
}

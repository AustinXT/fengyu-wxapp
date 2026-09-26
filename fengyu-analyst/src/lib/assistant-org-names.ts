import "server-only"

import { eq } from "drizzle-orm"
import { db } from "../db"
import { orgNodes, stores } from "../../../db/schema/org"

export interface AssistantOrgNameCatalog {
  storeNames: string[]
  marketNames: string[]
}

/**
 * 全部门店 / 市场名称：**不看在营、不看账号权限**，只供智能助手识别「问题点名了不可查看的门店或市场」
 * 后拒答（#436），不得用于取数或范围下拉。
 */
export async function getAssistantOrgNameCatalog(): Promise<AssistantOrgNameCatalog> {
  const [storeRows, marketRows] = await Promise.all([
    db.select({ name: stores.storeName }).from(stores),
    db.select({ name: orgNodes.name }).from(orgNodes).where(eq(orgNodes.type, "市场")),
  ])
  return {
    storeNames: storeRows.map((row) => row.name),
    marketNames: marketRows.map((row) => row.name),
  }
}

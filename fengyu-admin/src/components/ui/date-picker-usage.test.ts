import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

function collectTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = join(directory, entry.name)
    if (entry.isDirectory()) return collectTsxFiles(target)
    return entry.name.endsWith(".tsx") ? [target] : []
  })
}

describe("admin 日期选择器统一入口", () => {
  it("业务页面不再直接使用浏览器原生日期控件", () => {
    const appDirectory = join(process.cwd(), "src", "app")
    const offenders = collectTsxFiles(appDirectory).filter((file) => {
      const source = readFileSync(file, "utf8")
      return /type=["'](?:date|datetime-local)["']/.test(source)
    })

    expect(offenders).toEqual([])
  })
})

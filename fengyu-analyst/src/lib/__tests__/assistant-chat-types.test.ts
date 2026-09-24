import { describe, expect, it } from "vitest"
import {
  DEFAULT_ASSISTANT_CHAT_TITLE,
  normalizeAssistantVisualizations,
  titleFromAssistantQuestion,
} from "../assistant-types"

describe("assistant chat persistence DTOs", () => {
  it("derives the default title from the first question", () => {
    expect(titleFromAssistantQuestion("  今年   科颜美复购率是多少？ ")).toBe("今年 科颜美复购率是多少？")
    expect(titleFromAssistantQuestion("")).toBe(DEFAULT_ASSISTANT_CHAT_TITLE)
    expect(titleFromAssistantQuestion("a".repeat(23))).toBe(`${"a".repeat(22)}...`)
  })

  it("keeps only renderable visualization records after a database round trip", () => {
    expect(
      normalizeAssistantVisualizations([
        { id: "chart-1", kind: "bar", title: "门店对比", rows: [{ name: "A", value: 1 }] },
        { id: "chart-2", kind: "unknown", title: "坏数据" },
        { id: 3, kind: "line", title: "坏数据" },
        null,
      ]),
    ).toEqual([{ id: "chart-1", kind: "bar", title: "门店对比", rows: [{ name: "A", value: 1 }] }])
  })
})

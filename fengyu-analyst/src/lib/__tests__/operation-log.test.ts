import { describe, expect, it } from "vitest"
import { sanitizeDetail } from "../pii"

describe("operation-log", () => {
  describe("sanitizeDetail", () => {
    it("应该脱敏 phone 字段", () => {
      const input = {
        question: "上海门店有多少人",
        phone: "13812345678",
      }
      const result = sanitizeDetail(input)
      expect(result.phone).toBe("138****5678")
      expect(result.question).toBe("上海门店有多少人")
    })

    it("应该脱敏嵌套对象中的敏感字段", () => {
      const input = {
        _v: 1,
        _t: "chat",
        question: "查询客户信息",
        context: {
          phone: "13900001111",
          openid: "oABC123456789DEF",
        },
      }
      const result = sanitizeDetail(input)
      expect(result.context.phone).toBe("139****1111")
      expect(result.context.openid).toBe("oABC********9DEF")
      expect(result.question).toBe("查询客户信息")
    })

    it("应该保留非敏感字段", () => {
      const input = {
        _v: 1,
        _t: "chat",
        question: "今天的营业额是多少",
        hasAiAnswer: true,
        visualizationCount: 3,
      }
      const result = sanitizeDetail(input)
      expect(result).toEqual(input)
    })

    it("应该处理 null 和 undefined", () => {
      expect(sanitizeDetail(null)).toBeNull()
      expect(sanitizeDetail(undefined)).toBeUndefined()
      expect(sanitizeDetail({ phone: null })).toEqual({ phone: null })
    })

    it("应该处理数组", () => {
      const input = {
        users: [
          { name: "张三", phone: "13800138000" },
          { name: "李四", phone: "13900139000" },
        ],
      }
      const result = sanitizeDetail(input)
      expect(result.users[0].phone).toBe("138****8000")
      expect(result.users[1].phone).toBe("139****9000")
      expect(result.users[0].name).toBe("张三")
    })
  })
})

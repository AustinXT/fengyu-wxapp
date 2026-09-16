import { describe, expect, it } from 'vitest'
import { businessErrorMessage } from './action-error'
import { errorMessage } from './lakala-onboarding'

/**
 * 拉卡拉入网链路的错误透传守护（issue #133 评审 round 4）。
 *
 * round 3 把 `initiateElectronicContract` / 提交进件两处 catch 从「原样回传 err.message」
 * 改成 `businessErrorMessage(err, …)` —— 挡住了 PG/TypeError 泄漏，但**顺手吞掉了两类
 * 运维本该看到的可操作错误**：
 *
 * 1. `decodeSm4Key` 抛的 `LAKALA_SM4_KEY 必须是 16 字节…`，原先无白名单前缀 → 被来源闸门判死
 * 2. 504 的 `httpError` 原先整串含网关 URL（`Lakala https://… failed with 504，通常是附件过大…`）
 *    → 被内容闸门的 URL 技术特征判死，连「请压缩后重试」都透不出去
 *
 * 本文件锁住修复后的口径：**可操作的运维文案透传、技术细节仍然挡住**。
 */

/** 模拟 `initiateElectronicContract` / 提交进件 catch 分支的取值方式。 */
function shownToUser(thrown: unknown, fallback: string): string {
  return businessErrorMessage(thrown, fallback)
}

describe('拉卡拉入网：可操作的运维错误必须透传', () => {
  it('SM4 密钥配置错误（decodeSm4Key）', () => {
    const thrown = new Error('INVALID_STATE: LAKALA_SM4_KEY 必须是 16 字节，或对应的 base64/hex 编码')
    expect(shownToUser(thrown, '提交失败')).toBe(
      'LAKALA_SM4_KEY 必须是 16 字节，或对应的 base64/hex 编码',
    )
  })

  it('入网配置缺失（requireEnv）', () => {
    const thrown = new Error(
      'INVALID_STATE: 缺少入网配置 LAKALA_PRIVATE_KEY_PEM（LAKALA_CLIENT_MODE=real 时必填）',
    )
    expect(shownToUser(thrown, '提交失败')).toBe(
      '缺少入网配置 LAKALA_PRIVATE_KEY_PEM（LAKALA_CLIENT_MODE=real 时必填）',
    )
  })

  it('504 网关超时提示（不含 URL，用户拿到可操作建议）', () => {
    const thrown = new Error('INVALID_STATE: 拉卡拉网关超时，通常是附件过大，请压缩后重试')
    expect(shownToUser(thrown, '提交失败')).toBe('拉卡拉网关超时，通常是附件过大，请压缩后重试')
  })

  it('其它 HTTP 状态码的兜底提示', () => {
    const thrown = new Error('INVALID_STATE: 拉卡拉接口返回 502，请稍后重试或联系运维')
    expect(shownToUser(thrown, '提交失败')).toBe('拉卡拉接口返回 502，请稍后重试或联系运维')
  })

  it('供应商返回的中文拒绝原因', () => {
    const thrown = new Error('INVALID_STATE: 营业执照号码格式不正确，请核对后重新提交')
    expect(shownToUser(thrown, '提交失败')).toBe('营业执照号码格式不正确，请核对后重新提交')
  })

  it('本地校验错误（提交前补齐清单）', () => {
    const thrown = new Error('INVALID_PARAMS: 提交前请先补齐：法人身份证正面、营业执照')
    expect(shownToUser(thrown, '提交失败')).toBe('提交前请先补齐：法人身份证正面、营业执照')
  })
})

describe('拉卡拉入网：技术细节仍然挡住', () => {
  it.each([
    ['PG 约束冲突', new Error('duplicate key value violates unique constraint "uq_lakala_order_no"')],
    ['TypeError', new TypeError("Cannot read properties of undefined (reading 'merInnerNo')")],
    ['带网关 URL 的诊断串', new Error('INVALID_STATE: Lakala https://test.wsmsd.cn/sit/api failed with 504')],
    ['网络层错误', new Error('connect ETIMEDOUT 10.0.0.1:443')],
  ])('%s → 兜底', (_label, thrown) => {
    expect(shownToUser(thrown, '提交失败')).toBe('提交失败')
  })
})

/**
 * 覆盖 `postBody → errorMessage → action catch` 这一段。
 *
 * 此前本文件只手工构造最终 Error，`errorMessage()` 的候选排序一旦回退（响应体英文顶掉
 * 我方中文传输层提示）测试照样绿 —— 评审 round 5 指出的覆盖缺口。
 */
describe('errorMessage 候选排序：中文可操作提示不被英文响应体顶掉', () => {
  /** 模拟 action 侧：`throw new Error(\`INVALID_STATE: ${result.errorMessage}\`)` 后展示给用户。 */
  function endToEnd(raw: Record<string, unknown>, fallback: string): string {
    return businessErrorMessage(new Error(`INVALID_STATE: ${errorMessage(raw)}`), fallback)
  }

  it('504 且响应体是英文 Gateway Timeout → 仍展示我方可操作提示', () => {
    const raw = {
      message: 'Gateway Timeout',
      httpStatus: 504,
      httpError: '拉卡拉网关超时，通常是附件过大，请压缩后重试',
      httpDiagnostic: 'Lakala https://test.wsmsd.cn/sit/api failed with 504',
    }
    expect(endToEnd(raw, '提交失败')).toBe('拉卡拉网关超时，通常是附件过大，请压缩后重试')
  })

  it('供应商给了中文拒绝原因 → 优先展示它（比传输层提示更具体）', () => {
    const raw = {
      retMsg: '营业执照号码格式不正确，请核对后重新提交',
      httpStatus: 400,
      httpError: '拉卡拉接口返回 400，请稍后重试或联系运维',
    }
    expect(endToEnd(raw, '提交失败')).toBe('营业执照号码格式不正确，请核对后重新提交')
  })

  it('响应体与传输层都只有英文 → 回退业务兜底，不端英文给用户', () => {
    const raw = { message: 'Internal Server Error', httpStatus: 500 }
    expect(endToEnd(raw, '提交失败')).toBe('提交失败')
  })

  it('诊断串（含网关 URL）不会被选为展示文案', () => {
    const raw = {
      httpStatus: 504,
      httpError: '拉卡拉网关超时，通常是附件过大，请压缩后重试',
      httpDiagnostic: 'Lakala https://test.wsmsd.cn/sit/api failed with 504',
    }
    const shown = endToEnd(raw, '提交失败')
    expect(shown).not.toContain('https://')
    expect(shown).toBe('拉卡拉网关超时，通常是附件过大，请压缩后重试')
  })
})

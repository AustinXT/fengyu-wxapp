/**
 * 拉卡拉客户端 mock（仅用于 smoke-lakala-onboarding）。
 *
 * 与 _admin-preload.mjs 配合使用，叠加在 admin 上下文 mock 之上。
 * 用 bun plugin().module() 拦截 import @/lib/lakala-client，
 * 让所有 16 个方法返回固定 BBS00000/000000 + 合成 resp_data，
 * 避免连真实拉卡拉 API。
 *
 * 同时 mock @/lib/lakala-rate.loadRateConfig（避免 PG system_configs 缺 lakala.rate.entries 时 throw INVALID_STATE）。
 *
 * 测试脚本能通过 globalThis.__lakalaMocks 调整某次调用的返回（如让 submitMerchant 第一次 ok=true，
 * 第二次 ok=false 等）；默认全部成功。
 */
import { plugin } from 'bun'

// 全局可调可观测桩
globalThis.__lakalaMocks = {
  calls: [], // 按调用顺序收集 { method, args }
  responses: {}, // method → response override
}

function makeResp(method, defaultRespData) {
  const override = globalThis.__lakalaMocks.responses[method]
  if (override) return override
  return {
    code: '000000',
    msg: 'ok',
    resp_time: '',
    resp_data: defaultRespData,
    expectedCode: '000000',
    ok: true,
    reqId: 'mock-req-' + method + '-' + Date.now(),
  }
}

function record(method, args) {
  globalThis.__lakalaMocks.calls.push({ method, args })
}

plugin({
  name: 'admin-e2e-lakala-mocks',
  setup(build) {
    build.module('@/lib/lakala-client', () => ({
      exports: {
        // 入网相关 16 方法 + verifyResponseSignature
        applyContract: async (input) => {
          record('applyContract', input)
          return makeResp('applyContract', {
            ec_apply_id: 'MOCK_EC_APPLY_ID',
            order_no: input.orderNo,
            org_id: input.orgId,
          })
        },
        queryContract: async (input) => {
          record('queryContract', input)
          return makeResp('queryContract', {
            ec_apply_id: input.ecApplyId,
            ec_status: 'COMPLETED',
            ec_no: 'MOCK_EC_NO',
          })
        },
        downloadContract: async (input) => {
          record('downloadContract', input)
          return makeResp('downloadContract', { ec_file: 'base64encoded', ec_status: 'COMPLETED' })
        },
        uploadAttachment: async (input) => {
          record('uploadAttachment', input)
          return makeResp('uploadAttachment', {
            attFileId: 'MOCK_ATT_' + Math.random().toString(36).slice(2, 8),
          })
        },
        submitMerchant: async (input) => {
          record('submitMerchant', input)
          return makeResp('submitMerchant', { contractId: 'MOCK_CONTRACT_ID' })
        },
        queryMerchant: async (input) => {
          record('queryMerchant', input)
          return makeResp('queryMerchant', {
            contractStatus: 'WAIT_FOR_CONTACT',
            merInnerNo: 'MOCK_MER_INNER',
            merCupNo: 'MOCK_MER_CUP',
            termDatas: [{ termNo: 'MOCK_TERM_001' }],
          })
        },
        submitAppeal: async (input) => {
          record('submitAppeal', input)
          return makeResp('submitAppeal', { contractId: input.contractId })
        },
        querySubMerchantId: async (input) => {
          record('querySubMerchantId', input)
          return makeResp('querySubMerchantId', {
            registerStatus: 'SUCCESS',
            subMchId: 'MOCK_SUB_MCH',
            merInnerNo: input.merInnerNo,
          })
        },
        queryWxRealname: async (input) => {
          record('queryWxRealname', input)
          return makeResp('queryWxRealname', { realNameStatus: 'SUCCESS' })
        },
        submitWxRealname: async (input) => {
          record('submitWxRealname', input)
          return makeResp('submitWxRealname', {
            applymentId: 'MOCK_APPLY',
            qrcodeData: 'https://mock.qr/' + input.subMchId,
          })
        },
        modifyWxRealname: async (input) => {
          record('modifyWxRealname', input)
          return makeResp('modifyWxRealname', { applymentId: input.applymentId })
        },
        queryAlipayRealname: async (input) => {
          record('queryAlipayRealname', input)
          return makeResp('queryAlipayRealname', { realNameStatus: 'SUCCESS' })
        },
        submitAlipayRealname: async (input) => {
          record('submitAlipayRealname', input)
          return makeResp('submitAlipayRealname', {
            applymentId: 'MOCK_APPLY_ALI',
            qrcodeData: 'https://mock.qr.ali/' + input.subMchId,
          })
        },
        modifyAlipayRealname: async (input) => {
          record('modifyAlipayRealname', input)
          return makeResp('modifyAlipayRealname', { applymentId: input.applymentId })
        },
        queryWxConfig: async (input) => {
          record('queryWxConfig', input)
          return makeResp('queryWxConfig', { state: 'OPEN' })
        },
        updateLakalaMerchantInfo: async (input) => {
          record('updateLakalaMerchantInfo', input)
          return makeResp('updateLakalaMerchantInfo', { contractId: 'MOCK_CHG_CONTRACT' })
        },
        verifyResponseSignature: () => true,
        isReady: () => true,
        request: async () => makeResp('request', {}),
        requestRefund: async () => makeResp('requestRefund', {}),
        queryRefund: async () => makeResp('queryRefund', {}),
      },
      loader: 'object',
    }))

    // 费率配置：返回固定一项，避免 server action 内部 throw RATE_CONFIG_MISSING
    build.module('@/lib/lakala-rate', () => ({
      exports: {
        loadRateConfig: async () => ({
          entries: [{
            feeRateTypeCode: 'WX',
            feeRateTypeName: '微信',
            feeRatePct: '0.6',
            feeUpperAmtPcnt: '99999',
            feeLowerAmtPcnt: '0',
          }],
        }),
      },
      loader: 'object',
    }))

    // cloudbase：不真传 CDN
    build.module('@/lib/cloudbase', () => ({
      exports: {
        CDN_BASE: 'https://mock.cdn',
        uploadFile: async (_b, p) => 'https://mock.cdn/' + p,
        reuploadToFixedPath: async () => {},
        deleteByCloudPaths: async () => {},
        callClientFunction: async () => ({ code: 0, message: 'ok' }),
      },
      loader: 'object',
    }))
  },
})

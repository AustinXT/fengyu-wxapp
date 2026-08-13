'use server'

import { createPrivateKey, createPublicKey } from 'node:crypto'
import { access } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { getLakalaOnboardingClientMode, verifyOnboardingSm4Key } from '@/lib/lakala-onboarding'
import { getPrivateUploadRoot } from '@/lib/upload-file'
import { withPermission } from '@/lib/with-permission'

export type LakalaDiagnosticStatus = 'ok' | 'warn' | 'error'
export type LakalaDiagnosticItem = {
  key: string
  label: string
  status: LakalaDiagnosticStatus
  value: string
  detail?: string
}
export type LakalaDiagnostics = {
  generatedAt: string
  summary: LakalaDiagnosticStatus
  items: LakalaDiagnosticItem[]
}

function exists(...names: string[]): boolean {
  return names.some((name) => Boolean(process.env[name]?.trim()))
}

function configuredItem(key: string, label: string, names: string[], optional = false): LakalaDiagnosticItem {
  const configured = exists(...names)
  return {
    key,
    label,
    status: configured ? 'ok' : optional ? 'warn' : 'error',
    value: configured ? '已配置' : '未配置',
    detail: names.join(' / '),
  }
}

function safeGateway(envName: 'LAKALA_API_BASE' | 'LAKALA_ONBOARDING_API_BASE'): string {
  const value = process.env[envName]?.trim() || ''
  if (!value) return '未配置'
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`
  } catch {
    return '格式异常'
  }
}

function paymentSwitchItem(): LakalaDiagnosticItem {
  const value = process.env.PAYNOTIFY_ENABLED?.trim().toLowerCase()
  if (value === 'true') {
    return { key: 'paymentSwitch', label: '支付通知开关', status: 'ok', value: '已启用' }
  }
  if (value === 'false') {
    return {
      key: 'paymentSwitch',
      label: '支付通知开关',
      status: 'warn',
      value: '已停用',
      detail: 'PAYNOTIFY_ENABLED=false，拉卡拉支付通知入口不会处理业务请求。',
    }
  }
  return {
    key: 'paymentSwitch',
    label: '支付通知开关',
    status: 'error',
    value: '未配置或格式错误',
    detail: 'PAYNOTIFY_ENABLED 仅接受 true / false。',
  }
}

function signingKeyItem(
  key: string,
  label: string,
  envName: 'LAKALA_PRIVATE_KEY_PEM' | 'LAKALA_ONBOARDING_PRIVATE_KEY_PEM',
): LakalaDiagnosticItem {
  const pem = process.env[envName]?.replace(/\\n/g, '\n') || ''
  if (!pem) return { key, label, status: 'error', value: '未配置' }
  try {
    createPrivateKey(pem)
    return { key, label, status: 'ok', value: '已配置且可解析' }
  } catch {
    return { key, label, status: 'error', value: '已配置但无法解析' }
  }
}

function platformCertificateItem(): LakalaDiagnosticItem {
  const pem = process.env.LAKALA_PLATFORM_CERT_PEM?.replace(/\\n/g, '\n') || ''
  if (!pem) {
    return { key: 'paymentPlatformCert', label: '支付平台证书', status: 'error', value: '未配置' }
  }
  try {
    createPublicKey(pem)
    return {
      key: 'paymentPlatformCert',
      label: '支付平台证书',
      status: 'ok',
      value: '已配置且可解析',
    }
  } catch {
    return {
      key: 'paymentPlatformCert',
      label: '支付平台证书',
      status: 'error',
      value: '已配置但无法解析',
    }
  }
}

async function onboardingPrivateKeyItem(): Promise<LakalaDiagnosticItem> {
  const key = process.env.LAKALA_ONBOARDING_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n') || ''
  if (!key) return { key: 'onboardingPrivateKey', label: '入网商户私钥', status: 'error', value: '未配置' }
  try {
    createPrivateKey(key)
    return { key: 'onboardingPrivateKey', label: '入网商户私钥', status: 'ok', value: '已配置且可解析' }
  } catch {
    return { key: 'onboardingPrivateKey', label: '入网商户私钥', status: 'error', value: '已配置但无法解析' }
  }
}

async function paymentDatabaseItem(): Promise<LakalaDiagnosticItem> {
  try {
    const [tableRow] = (await db.execute(sql`
      SELECT to_regclass('public.lakala_merchants') IS NOT NULL AS merchants
    `)) as unknown as Array<{ merchants: boolean }>
    if (!tableRow?.merchants) {
      return { key: 'paymentDatabase', label: '收款商户配置', status: 'error', value: '数据表缺失' }
    }

    const [row] = (await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE enabled) AS enabled_count,
        COUNT(*) FILTER (
          WHERE enabled AND (
            merchant_no IS NULL OR BTRIM(merchant_no) = ''
            OR term_no IS NULL OR BTRIM(term_no) = ''
          )
        ) AS incomplete_count
      FROM lakala_merchants
    `)) as unknown as Array<{ enabled_count: string | number; incomplete_count: string | number }>
    const enabledCount = Number(row?.enabled_count || 0)
    const incompleteCount = Number(row?.incomplete_count || 0)
    if (incompleteCount > 0) {
      return {
        key: 'paymentDatabase',
        label: '收款商户配置',
        status: 'error',
        value: `${incompleteCount} 个启用商户配置不完整`,
        detail: '启用的商户必须同时配置商户号和终端号。',
      }
    }
    return {
      key: 'paymentDatabase',
      label: '收款商户配置',
      status: enabledCount > 0 ? 'ok' : 'warn',
      value: enabledCount > 0 ? `${enabledCount} 个启用商户已就绪` : '暂无启用商户',
    }
  } catch {
    return { key: 'paymentDatabase', label: '收款商户配置', status: 'error', value: '检查失败' }
  }
}

async function databaseItem(): Promise<LakalaDiagnosticItem> {
  try {
    const [row] = (await db.execute(sql`
      SELECT
        to_regclass('public.lakala_onboarding_applications') IS NOT NULL AS applications,
        to_regclass('public.lakala_onboarding_attachments') IS NOT NULL AS attachments,
        to_regclass('public.lakala_onboarding_request_logs') IS NOT NULL AS request_logs
    `)) as unknown as Array<{ applications: boolean; attachments: boolean; request_logs: boolean }>
    const ready = Boolean(row?.applications && row.attachments && row.request_logs)
    return {
      key: 'database',
      label: '入网数据库表',
      status: ready ? 'ok' : 'error',
      value: ready ? '3 张表均已就绪' : '表不完整',
    }
  } catch {
    return { key: 'database', label: '入网数据库表', status: 'error', value: '检查失败' }
  }
}

async function privateStorageItem(): Promise<LakalaDiagnosticItem> {
  try {
    const root = getPrivateUploadRoot()
    await access(root)
    return { key: 'storage', label: '私有附件目录', status: 'ok', value: '已配置且可访问' }
  } catch (error) {
    return {
      key: 'storage',
      label: '私有附件目录',
      status: 'error',
      value: '不可访问',
      detail: error instanceof Error ? error.message : undefined,
    }
  }
}

function sm4Item(mode: 'real' | 'mock' | 'disabled'): LakalaDiagnosticItem {
  try {
    verifyOnboardingSm4Key()
    return { key: 'sm4', label: 'SM4 加密密钥', status: 'ok', value: '已配置且格式正确' }
  } catch {
    return {
      key: 'sm4',
      label: 'SM4 加密密钥',
      status: mode === 'real' ? 'error' : 'warn',
      value: '未配置或格式错误',
      detail: mode === 'real' ? '真实 merchant_encry 调用必须配置。' : 'mock 模式不会使用该密钥。',
    }
  }
}

export const getLakalaDiagnostics = withPermission(
  'system:diagnostics',
  async (): Promise<LakalaDiagnostics> => {
    let mode: 'real' | 'mock' | 'disabled' = 'disabled'
    try {
      mode = getLakalaOnboardingClientMode()
    } catch {
      // 由下方调用模式项明确展示非法配置。
    }
    const ocrMode = process.env.ALIYUN_OCR_MODE?.trim().toLowerCase() || 'real'
    const ocrReady = ocrMode === 'mock' || exists('ALIYUN_OCR_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_ID')
      && exists('ALIYUN_OCR_ACCESS_KEY_SECRET', 'ALIYUN_ACCESS_KEY_SECRET')
    const paymentGateway = safeGateway('LAKALA_API_BASE')
    const onboardingGateway = safeGateway('LAKALA_ONBOARDING_API_BASE')
    const items: LakalaDiagnosticItem[] = [
      paymentSwitchItem(),
      {
        key: 'paymentGateway',
        label: '支付网关',
        status: paymentGateway === '未配置' || paymentGateway === '格式异常' ? 'error' : 'ok',
        value: paymentGateway,
        detail: '仅展示协议与主机名，不发起真实交易。',
      },
      configuredItem('paymentAppId', '支付应用 ID', ['LAKALA_APPID']),
      configuredItem('paymentSerialNo', '支付证书序列号', ['LAKALA_SERIAL_NO']),
      signingKeyItem('paymentPrivateKey', '支付签名私钥', 'LAKALA_PRIVATE_KEY_PEM'),
      platformCertificateItem(),
      configuredItem('paymentNotifyUrl', '支付通知地址', ['LAKALA_NOTIFY_URL']),
      configuredItem('paymentIpWhitelist', '回调 IP 白名单', ['LAKALA_CALLBACK_IP_WHITELIST']),
      await paymentDatabaseItem(),
      {
        key: 'clientMode',
        label: '入网调用模式',
        status: mode === 'real' ? 'ok' : mode === 'mock' ? 'warn' : 'error',
        value: mode,
        detail: mode === 'mock' ? '不会向拉卡拉创建真实商户或合同。' : undefined,
      },
      {
        key: 'gateway',
        label: '入网网关',
        status: onboardingGateway === '未配置' || onboardingGateway === '格式异常' ? 'error' : 'ok',
        value: onboardingGateway,
        detail: '仅展示协议与主机名。',
      },
      configuredItem('appId', '入网应用 ID', ['LAKALA_ONBOARDING_APPID']),
      configuredItem('serialNo', '入网证书序列号', ['LAKALA_ONBOARDING_SERIAL_NO']),
      configuredItem('platformCert', '拉卡拉平台证书', ['LAKALA_ONBOARDING_PLATFORM_CERT_PEM']),
      configuredItem('orgCode', '入网机构号', ['LAKALA_ONBOARDING_ORG_CODE']),
      configuredItem('userNo', '入网用户号', ['LAKALA_ONBOARDING_USER_NO']),
      configuredItem('activityId', '入网活动 ID', ['LAKALA_ONBOARDING_ACTIVITY_ID']),
      configuredItem('callback', '电子合同回调地址', ['LAKALA_ECONTRACT_CALLBACK_URL']),
      await onboardingPrivateKeyItem(),
      sm4Item(mode),
      {
        key: 'ocr',
        label: '阿里云 OCR',
        status: ocrReady ? (ocrMode === 'mock' ? 'warn' : 'ok') : 'error',
        value: ocrReady ? `${ocrMode} 模式已就绪` : '凭据未配置',
        detail: '不展示 AccessKey。',
      },
      await databaseItem(),
      await privateStorageItem(),
    ]
    const summary: LakalaDiagnosticStatus = items.some((item) => item.status === 'error')
      ? 'error'
      : items.some((item) => item.status === 'warn') ? 'warn' : 'ok'
    return { generatedAt: new Date().toISOString(), summary, items }
  },
)

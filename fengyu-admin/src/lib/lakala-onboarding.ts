import { createCipheriv, createDecipheriv, createSign, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { UploadFileLike } from "@/lib/upload-file";
import { DEFAULT_LAKALA_VALUES } from "./lakala-onboarding-constants";
export { AGREEMENT_ATTACHMENT, ATTACHMENT_REQUIREMENTS, DEFAULT_FEE_DATA, DEFAULT_LAKALA_VALUES, MAX_ONBOARDING_ATTACHMENT_BYTES, normalizeTkbsAttachmentType } from "./lakala-onboarding-constants";

const SENSITIVE_KEYS = [
  "larIdcard",
  "lar_id_card",
  "account_id_card",
  "acctNo",
  "account_no",
  "merContactMobile",
  "contact_mobile",
  "shopContactMobile",
  "attContext",
  "file_base64",
  "privateKey",
  "sm4Key",
  "signature",
];

export type UploadFileInput = {
  applicationId?: string;
  orderNo: string;
  attType: string;
  attExtName: string;
  attContext: string;
};

export type UploadFileResult = {
  success: boolean;
  attFileId?: string;
  fileUrl?: string;
  showUrl?: string;
  batchNo?: string;
  ocrStatus?: string;
  ocrResult?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  raw: Record<string, unknown>;
};

export type AddMerchantResult = {
  success: boolean;
  contractId?: string;
  merInnerNo?: string;
  merCupNo?: string;
  errorCode?: string;
  errorMessage?: string;
  raw: Record<string, unknown>;
};

export type ElectronicContractResult = {
  success: boolean;
  orderNo?: string;
  applyId?: string;
  resultUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  raw: Record<string, unknown>;
};

export type QuerySubMerchantResult = {
  success: boolean;
  status: "REGISTERING" | "SUCCESS" | "FAILED";
  merchantNo?: string;
  innerCustomerNo?: string;
  terminalNo?: string;
  errorCode?: string;
  errorMessage?: string;
  raw: Record<string, unknown>;
};

export type ReconsiderMerchantResult = {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  raw: Record<string, unknown>;
};

export type ChannelSubMerchantResult = {
  success: boolean;
  wechat: Array<{ subMerchantNo: string; registerType: string; channelId: string; registerChannelName: string }>;
  alipay: Array<{ subMerchantNo: string; registerType: string; channelId: string; registerChannelName: string }>;
  errorCode?: string;
  errorMessage?: string;
  raw: Record<string, unknown>;
};

export type ChannelCertificationResult = {
  success: boolean;
  registerType: "WXZF" | "ZFBZF";
  subMchId?: string;
  merchantNo?: string;
  innerCustomerNo?: string;
  customerName?: string;
  registerState?: string;
  authorizeState?: string;
  applymentState?: string;
  registerCode?: string;
  registerMsg?: string;
  rejectReason?: string;
  applymentId?: string;
  channelId?: string;
  errorCode?: string;
  errorMessage?: string;
  raw: Record<string, unknown>;
};

export type MerchantAuthStateResult = {
  success: boolean;
  tradeMode: "WECHAT" | "ALIPAY";
  merchantNo: string;
  subMerchantId: string;
  checkResult?: string;
  errorCode?: string;
  errorMessage?: string;
  raw: Record<string, unknown>;
};

export type LakalaBankOption = {
  branchBankNo: string;
  clearNo: string;
  branchBankName: string;
  areaCode?: string;
  bankNo?: string;
};

type LakalaLocalBankRow = LakalaBankOption & {
  areaCode: string;
  bankNo: string;
};

type LakalaLocalMerchantAreaRow = {
  code: string;
  name: string;
  parentCode: string;
};

export type LakalaMerchantRegion = {
  provinceCode: string;
  cityCode: string;
  countyCode: string;
  label: string;
};

let localBankBranchesCache: LakalaLocalBankRow[] | null = null;
let localMerchantAreasCache: Map<string, LakalaLocalMerchantAreaRow> | null = null;

function normalizeBankKeyword(value: string) {
  return value.replace(/\s+/g, "").trim();
}

function normalizeBankTokens(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .map(normalizeBankKeyword)
    .filter(Boolean);
}

async function readLocalBankBranches() {
  if (localBankBranchesCache) return localBankBranchesCache;
  const candidates = [
    path.join(process.cwd(), "public", "data", "lakala-bank-branches.tsv"),
    path.join(process.cwd(), "fengyu-admin", "public", "data", "lakala-bank-branches.tsv"),
  ];
  let content = "";
  for (const candidate of candidates) {
    try {
      content = await readFile(candidate, "utf-8");
      break;
    } catch {
      // Next standalone runs from /app; local scripts may run from the monorepo root.
    }
  }
  if (!content) {
    localBankBranchesCache = [];
    return localBankBranchesCache;
  }
  const [, ...lines] = content.split(/\r?\n/);
  localBankBranchesCache = lines.flatMap((line) => {
    if (!line) return [];
    const [areaCode, bankNo, branchBankName, branchBankNo, clearNo] = line.split("\t");
    if (!areaCode || !branchBankName || !branchBankNo || !clearNo) return [];
    return [{ areaCode, bankNo: bankNo || "", branchBankName, branchBankNo, clearNo }];
  });
  return localBankBranchesCache;
}

function readLocalMerchantAreas() {
  if (localMerchantAreasCache) return localMerchantAreasCache;
  const candidates = [
    path.join(process.cwd(), "public", "data", "lakala-merchant-areas.tsv"),
    path.join(process.cwd(), "fengyu-admin", "public", "data", "lakala-merchant-areas.tsv"),
  ];
  let content = "";
  for (const candidate of candidates) {
    try {
      content = readFileSync(candidate, "utf-8");
      break;
    } catch {
      // Next standalone runs from /app; local scripts may run from the monorepo root.
    }
  }
  const [, ...lines] = content.split(/\r?\n/);
  localMerchantAreasCache = new Map();
  for (const line of lines) {
    if (!line) continue;
    const [code, name, parentCode] = line.split("\t");
    if (!code || !name) continue;
    localMerchantAreasCache.set(code, { code, name, parentCode: parentCode || "" });
  }
  return localMerchantAreasCache;
}

export function resolveLocalLakalaMerchantRegionByCode(code?: string | null): LakalaMerchantRegion | null {
  if (!code) return null;
  const rows = readLocalMerchantAreas();
  const selected = rows.get(code);
  if (!selected) return null;

  const chain: LakalaLocalMerchantAreaRow[] = [];
  const seen = new Set<string>();
  let current: LakalaLocalMerchantAreaRow | undefined = selected;
  while (current && !seen.has(current.code)) {
    seen.add(current.code);
    if (current.code !== "1" && current.parentCode !== "") chain.push(current);
    if (!current.parentCode || current.parentCode === "1" || current.parentCode === "991000") break;
    current = rows.get(current.parentCode);
  }

  const pathRows = chain.reverse();
  if (!pathRows.length) return null;

  const province = pathRows[0];
  const city = pathRows.length >= 3 ? pathRows[1] : province;
  const county = pathRows[pathRows.length - 1];
  if (!province?.code || !city?.code || !county?.code) return null;

  return {
    provinceCode: province.code,
    cityCode: city.code,
    countyCode: county.code,
    label: pathRows.map((item) => item.name).join(""),
  };
}

export async function queryLocalLakalaBanks(input: { areaCode: string; bankName: string; limit?: number }): Promise<LakalaBankOption[]> {
  const keyword = normalizeBankKeyword(input.bankName);
  if (!input.areaCode || keyword.length < 2) return [];
  const rows = await readLocalBankBranches();
  const matches: Array<LakalaLocalBankRow & { score: number }> = [];
  for (const row of rows) {
    if (row.areaCode !== input.areaCode) continue;
    const name = normalizeBankKeyword(row.branchBankName);
    if (!name.includes(keyword)) continue;
    const score = name === keyword ? 0 : name.startsWith(keyword) ? 1 : name.indexOf(keyword) + 2;
    matches.push({ ...row, score });
  }
  matches.sort((a, b) => a.score - b.score || a.branchBankName.length - b.branchBankName.length || a.branchBankName.localeCompare(b.branchBankName, "zh-Hans-CN"));
  return matches.slice(0, input.limit ?? 80).map(({ branchBankNo, clearNo, branchBankName, areaCode, bankNo }) => ({ branchBankNo, clearNo, branchBankName, areaCode, bankNo }));
}

export async function queryLocalLakalaBanksByAreaKeywords(input: { areaKeywords: string[]; bankName: string; limit?: number }): Promise<LakalaBankOption[]> {
  const keyword = normalizeBankKeyword(input.bankName);
  const keywordTokens = normalizeBankTokens(input.bankName);
  const areaKeywords = input.areaKeywords.map(normalizeBankKeyword).filter((item) => item.length >= 2);
  if (keyword.length < 2) return [];
  const rows = await readLocalBankBranches();
  const matches: Array<LakalaLocalBankRow & { score: number }> = [];
  for (const row of rows) {
    const name = normalizeBankKeyword(row.branchBankName);
    const keywordMatched = keywordTokens.length ? keywordTokens.every((token) => name.includes(token)) : name.includes(keyword);
    if (!keywordMatched && !name.includes(keyword)) continue;

    const areaIndex = areaKeywords.findIndex((areaKeyword) => name.includes(areaKeyword));
    if (areaKeywords.length && areaIndex < 0) continue;

    const score =
      (areaIndex < 0 ? 50 : areaIndex * 10) +
      (name === keyword ? 0 : name.startsWith(keyword) ? 1 : Math.max(name.indexOf(keyword), 0) + 2);
    matches.push({ ...row, score });
  }
  matches.sort((a, b) => a.score - b.score || a.branchBankName.length - b.branchBankName.length || a.branchBankName.localeCompare(b.branchBankName, "zh-Hans-CN"));
  return matches.slice(0, input.limit ?? 80).map(({ branchBankNo, clearNo, branchBankName, areaCode, bankNo }) => ({ branchBankNo, clearNo, branchBankName, areaCode, bankNo }));
}

export async function findLocalLakalaBankAreaCodes(input: { areaKeywords: string[]; limit?: number }): Promise<string[]> {
  const areaKeywords = input.areaKeywords.map(normalizeBankKeyword).filter((item) => item.length >= 2);
  if (!areaKeywords.length) return [];
  const rows = await readLocalBankBranches();
  const counts = new Map<string, { areaCode: string; count: number; score: number }>();
  for (const row of rows) {
    const name = normalizeBankKeyword(row.branchBankName);
    const areaIndex = areaKeywords.findIndex((areaKeyword) => name.includes(areaKeyword));
    if (areaIndex < 0) continue;
    const current = counts.get(row.areaCode) ?? { areaCode: row.areaCode, count: 0, score: areaIndex };
    current.count += 1;
    current.score = Math.min(current.score, areaIndex);
    counts.set(row.areaCode, current);
  }
  return [...counts.values()]
    .sort((a, b) => a.score - b.score || b.count - a.count || a.areaCode.localeCompare(b.areaCode))
    .slice(0, input.limit ?? 5)
    .map((item) => item.areaCode);
}

function envValue(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}

export function getLakalaOnboardingApiFamily() {
  return envValue("LAKALA_API_FAMILY") === "mms" ? "mms" : "tkbs";
}

function normalizeLakalaEnv(value: string | undefined) {
  return value === "prod" || value === "release" ? "prod" : "test";
}

export function getLakalaOnboardingEnv() {
  return normalizeLakalaEnv(process.env.LAKALA_ENV);
}

export function getLakalaOnboardingClientMode() {
  return envValue("LAKALA_CLIENT_MODE") === "real" ? "real" : "mock";
}

export function getLakalaBaseUrl() {
  const env = getLakalaOnboardingEnv();
  const family = getLakalaOnboardingApiFamily();
  if (family === "tkbs") {
    return env === "prod"
      ? envValue("LAKALA_ONBOARDING_API_BASE", "LAKALA_ONBOARDING_PROD_BASE_URL") || "https://s2.lakala.com"
      : envValue("LAKALA_ONBOARDING_API_BASE", "LAKALA_ONBOARDING_TEST_BASE_URL") || "https://test.wsmsd.cn/sit";
  }
  return env === "prod"
    ? envValue("LAKALA_ONBOARDING_API_BASE", "LAKALA_ONBOARDING_PROD_BASE_URL") || "https://s2.lakala.com/api/v2/mms/openApi"
    : envValue("LAKALA_ONBOARDING_API_BASE", "LAKALA_ONBOARDING_TEST_BASE_URL") || "https://test.wsmsd.cn/sit/api/v2/mms/openApi";
}

export function getOrgCode() {
  return envValue("LAKALA_ORG_CODE");
}

export function getOnboardingAppId() {
  return envValue("LAKALA_APPID");
}

export function getOnboardingSerialNo() {
  return envValue("LAKALA_SERIAL_NO");
}

export function getOnboardingUserNo() {
  return envValue("LAKALA_USER_NO");
}

export function getOnboardingSm4Key() {
  return envValue("LAKALA_SM4_KEY");
}

export function getOnboardingActivityId() {
  return envValue("LAKALA_ACTIVITY_ID");
}

export function getOnboardingMcc() {
  return envValue("LAKALA_MCC") || DEFAULT_LAKALA_VALUES.mccCode;
}

export function getOnboardingBusiCode() {
  return envValue("LAKALA_ONBOARDING_BUSI_CODE") || DEFAULT_LAKALA_VALUES.posType;
}

export function getOnboardingSettlementType() {
  return envValue("LAKALA_SETTLEMENT_TYPE") || DEFAULT_LAKALA_VALUES.settlementType;
}

export function getOnboardingSource() {
  return envValue("LAKALA_SOURCE") || DEFAULT_LAKALA_VALUES.source;
}

export function getOnboardingEmail() {
  return envValue("LAKALA_ONBOARDING_EMAIL") || "lakala-onboarding@fengyu.local";
}

export function getOnboardingLatitude() {
  return envValue("LAKALA_ONBOARDING_DEFAULT_LATITUDE") || "28.682892";
}

export function getOnboardingLongtude() {
  return envValue("LAKALA_ONBOARDING_DEFAULT_LONGTUDE", "LAKALA_ONBOARDING_DEFAULT_LONGITUDE") || "115.858197";
}

export function getMerchantBusinessContent() {
  return envValue("LAKALA_ONBOARDING_MER_BUSI_CONTENT", "LAKALA_ONBOARDING_BUSINESS_CONTENT") || "美容美发服务";
}

export function getEContractCallbackUrl() {
  return envValue("LAKALA_ECONTRACT_CALLBACK_URL");
}

export function getEContractOrgId() {
  return getOrgCode();
}

export function getEContractType() {
  return envValue("LAKALA_ECONTRACT_TYPE") || "EC015";
}

function requireEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`${names.join(" or ")} is required when LAKALA_CLIENT_MODE=real`);
}

async function resolvePrivateKey() {
  return requireEnv("LAKALA_PRIVATE_KEY_PEM").replace(/\\n/g, "\n");
}

async function signBody(body: string) {
  const appId = requireEnv("LAKALA_APPID");
  const serialNo = requireEnv("LAKALA_SERIAL_NO");
  const privateKey = await resolvePrivateKey();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = randomBytes(16).toString("hex");
  const message = `${appId}\n${serialNo}\n${timestamp}\n${nonceStr}\n${body}\n`;
  const signer = createSign("RSA-SHA256");
  signer.update(message);
  signer.end();
  const signature = signer.sign(privateKey, "base64");
  return {
    appId,
    authorization: `LKLAPI-SHA256withRSA appid="${appId}",serial_no="${serialNo}",timestamp="${timestamp}",nonce_str="${nonceStr}",signature="${signature}"`,
  };
}

async function post(pathname: string, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  return postBody(pathname, body);
}

async function postBody(pathname: string, body: string) {
  const signed = await signBody(body);
  const response = await fetch(`${getLakalaBaseUrl()}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: signed.authorization,
      appId: signed.appId,
    },
    body,
  });
  const text = await response.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    json = { rawText: text };
  }
  if (!response.ok) {
    return {
      ...json,
      httpStatus: response.status,
      // 诊断信息（含网关 URL）只进日志/DB；面向用户的那句必须单独给，否则整串因含 https://
      // 被内容闸门判死，连「附件过大…请压缩后重试」这种可操作提示都透不出去（评审 round 4）
      httpDiagnostic: `Lakala ${getLakalaBaseUrl()}${pathname} failed with ${response.status}`,
      // 不带前缀：调用方抛出时会补 `INVALID_STATE: `（见 initiateElectronicContract）
      httpError:
        response.status === 504
          ? "拉卡拉网关超时，通常是附件过大，请压缩后重试"
          : `拉卡拉接口返回 ${response.status}，请稍后重试或联系运维`,
    };
  }
  return json;
}

function isSuccess(raw: Record<string, unknown>) {
  return raw.code === "000000" || raw.code === "0000" || raw.retCode === "000000" || raw.retCode === "0000" || raw.respCode === "0000";
}

function errorMessage(raw: Record<string, unknown>) {
  const message = typeof raw.message === "string"
    ? raw.message
    : typeof raw.msg === "string"
      ? raw.msg
      : typeof raw.retMsg === "string"
        ? raw.retMsg
        : typeof raw.httpError === "string"
          ? raw.httpError
          : undefined;
  if (message) return message;
  const code = raw.code || raw.retCode || raw.respCode || raw.httpStatus;
  return code ? `拉卡拉返回错误码：${String(code)}` : undefined;
}

function tkbsEnvelope(reqData: Record<string, unknown>) {
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return {
    ver: DEFAULT_LAKALA_VALUES.tkbsVersion,
    // 拓客商服最新公共参数要求 yyyyMMddHHmmss（14 位），不能沿用旧示例的毫秒时间戳。
    timestamp,
    req_id: `fy${Date.now()}${randomBytes(4).toString("hex")}`,
    req_data: reqData,
  };
}

function decodeSm4Key(value: string) {
  const trimmed = value.trim();
  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length === 16) return base64;
  const hex = Buffer.from(trimmed, "hex");
  if (hex.length === 16) return hex;
  const utf8 = Buffer.from(trimmed, "utf8");
  if (utf8.length === 16) return utf8;
  // 带白名单前缀才能穿过 businessErrorMessage 的来源闸门：这是**给运维看的可操作配置错误**，
  // 与「密码加密未配置（缺少 RSA_PRIVATE_KEY）」同类，不该被兜底文案吞掉（issue #133 评审 round 4）
  throw new Error("INVALID_STATE: LAKALA_SM4_KEY 必须是 16 字节，或对应的 base64/hex 编码");
}

function resolveSm4KeyBuffer() {
  return decodeSm4Key(requireEnv("LAKALA_SM4_KEY"));
}

export function verifyOnboardingSm4Key() {
  resolveSm4KeyBuffer();
}

function sm4Encrypt(body: string) {
  const cipher = createCipheriv("sm4-ecb", resolveSm4KeyBuffer(), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(body, "utf8"), cipher.final()]).toString("base64");
}

function sm4Decrypt(cipherText: string) {
  const decipher = createDecipheriv("sm4-ecb", resolveSm4KeyBuffer(), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(cipherText, "base64"), decipher.final()]).toString("utf8");
}

function parseEncryptedResponse(raw: Record<string, unknown>) {
  if (typeof raw.rawText !== "string") return raw;
  const text = raw.rawText.trim();
  if (!text) return raw;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(sm4Decrypt(text)) as Record<string, unknown>;
    } catch {
      return raw;
    }
  }
}

async function postTkbsEncrypted(pathname: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const envelope = tkbsEnvelope(payload);
  const plainBody = JSON.stringify(envelope);
  const encryptedBody = sm4Encrypt(plainBody);
  const raw = await postBody(pathname, encryptedBody);
  const parsed: Record<string, unknown> = parseEncryptedResponse(raw);
  return {
    ...parsed,
    request_req_id: envelope.req_id,
  };
}

function responseData(raw: Record<string, unknown>) {
  return (raw.resp_data || raw.respData || raw.data || raw) as Record<string, unknown>;
}

function mmsEnvelope(reqData: Record<string, unknown>) {
  return {
    ver: "1.0.0",
    timestamp: String(Date.now()),
    reqId: randomBytes(16).toString("hex"),
    reqData,
  };
}

export async function lakalaUploadFile(input: UploadFileInput): Promise<UploadFileResult> {
  if (getLakalaOnboardingClientMode() !== "real") {
    const fileUrl = `merchant/mock/${input.orderNo}/${Date.now()}${input.attType}.png`;
    return {
      success: true,
      attFileId: fileUrl,
      fileUrl,
      showUrl: fileUrl,
      ocrStatus: "00",
      raw: { code: "000000", msg: "mock upload success", resp_data: { url: fileUrl, show_url: fileUrl, status: "00", img_type: input.attType } },
    };
  }
  if (getLakalaOnboardingApiFamily() !== "tkbs") {
    const raw = await post("/uploadFile", input as unknown as Record<string, unknown>);
    const data = responseData(raw);
    const attFileId = typeof data.attFileId === "string" ? data.attFileId : undefined;
    return {
      success: isSuccess(raw) && Boolean(attFileId),
      attFileId,
      errorCode: String(raw.code || raw.retCode || raw.httpStatus || ""),
      errorMessage: errorMessage(raw),
      raw,
    };
  }
  const payload = tkbsEnvelope({
    file_base64: `data:image/png;base64,${input.attContext}`,
    img_type: input.attType,
    prefix: "reg",
    sourcechnl: "0",
    is_ocr: ["BUSINESS_LICENSE", "BUSINESS_LICENCE", "ID_CARD_FRONT", "ID_CARD_BEHIND", "ID_CARD_BACK", "FR_ID_CARD_FRONT", "FR_ID_CARD_BEHIND"].includes(input.attType) ? "true" : "false",
  });
  const raw = await post("/api/v3/tkbs/customer/file/upload", payload);
  const data = responseData(raw);
  const fileUrl = typeof data.url === "string" ? data.url : undefined;
  return {
    success: isSuccess(raw) && Boolean(fileUrl),
    attFileId: fileUrl,
    fileUrl,
    showUrl: typeof data.show_url === "string" ? data.show_url : undefined,
    batchNo: typeof data.batch_no === "string" ? data.batch_no : undefined,
    ocrStatus: typeof data.status === "string" ? data.status : undefined,
    ocrResult: data.result && typeof data.result === "object" ? data.result as Record<string, unknown> : undefined,
    errorCode: String(raw.code || raw.retCode || raw.httpStatus || ""),
    errorMessage: errorMessage(raw),
    raw,
  };
}

export async function lakalaQueryOcrResult(input: { imgType: string; batchNo: string }): Promise<UploadFileResult> {
  if (getLakalaOnboardingClientMode() !== "real") {
    return {
      success: true,
      batchNo: input.batchNo,
      ocrStatus: "00",
      raw: { code: "000000", msg: "mock ocr success", resp_data: { batch_no: input.batchNo, status: "00" } },
    };
  }
  const raw = await post("/api/v3/tkbs/ocr_result", tkbsEnvelope({ img_type: input.imgType, batch_no: input.batchNo }));
  const data = responseData(raw);
  return {
    success: isSuccess(raw) && data.status !== "02",
    fileUrl: typeof data.url === "string" ? data.url : undefined,
    showUrl: typeof data.show_url === "string" ? data.show_url : undefined,
    batchNo: typeof data.batch_no === "string" ? data.batch_no : input.batchNo,
    ocrStatus: typeof data.status === "string" ? data.status : undefined,
    ocrResult: data.result && typeof data.result === "object" ? data.result as Record<string, unknown> : undefined,
    errorCode: String(raw.code || raw.retCode || raw.httpStatus || ""),
    errorMessage: errorMessage(raw),
    raw,
  };
}

export async function lakalaAddMerchant(reqData: Record<string, unknown>): Promise<AddMerchantResult> {
  if (getLakalaOnboardingClientMode() !== "real") {
    const orderNo = String(reqData.external_no || Date.now());
    return {
      success: true,
      contractId: `MOCK-CONTRACT-${orderNo}`,
      merInnerNo: `MOCK-INNER-${orderNo.slice(-8)}`,
      merCupNo: `MOCK-CUP-${orderNo.slice(-8)}`,
      raw: { code: "000000", msg: "mock merchant success", resp_data: { merchant_no: `MOCK-${orderNo.slice(-8)}`, status: "WAIT_AUDI" } },
    };
  }
  const raw = getLakalaOnboardingApiFamily() === "tkbs"
    ? await postTkbsEncrypted("/api/v3/tkbs/merchant_encry", reqData)
    : await post("/addMer", reqData);
  const data = responseData(raw);
  const merchantNo = typeof data.merchant_no === "string" ? data.merchant_no : undefined;
  return {
    success: isSuccess(raw),
    contractId: typeof data.contractId === "string" ? data.contractId : undefined,
    merInnerNo: typeof data.merInnerNo === "string" ? data.merInnerNo : merchantNo,
    merCupNo: typeof data.merCupNo === "string" ? data.merCupNo : merchantNo,
    errorCode: String(raw.code || raw.retCode || ""),
    errorMessage: errorMessage(raw),
    raw,
  };
}

export async function lakalaApplyElectronicContract(reqData: Record<string, unknown>): Promise<ElectronicContractResult> {
  const now = new Date();
  const reqTime = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const raw = await post("/api/v3/mms/open_api/ec/apply", {
    req_time: reqTime,
    version: "3.0",
    req_data: reqData,
  });
  const data = responseData(raw);
  return {
    success: isSuccess(raw),
    orderNo: typeof data.order_no === "string" ? data.order_no : undefined,
    applyId: data.ec_apply_id === undefined || data.ec_apply_id === null ? undefined : String(data.ec_apply_id),
    resultUrl: typeof data.result_url === "string" ? data.result_url : undefined,
    errorCode: String(raw.code || raw.retCode || raw.httpStatus || ""),
    errorMessage: errorMessage(raw),
    raw,
  };
}

export async function lakalaQuerySubMerchant(input: { contractId?: string | null; merInnerNo?: string | null; merCupNo?: string | null }): Promise<QuerySubMerchantResult> {
  if (getLakalaOnboardingClientMode() !== "real") {
    return {
      success: true,
      status: "SUCCESS",
      raw: { code: "0000", message: "mock query success", data: { contractId: input.contractId, registerStatus: "SUCCESS" } },
    };
  }
  if (getLakalaOnboardingApiFamily() === "tkbs") {
    const customerNo = input.merInnerNo || input.merCupNo;
    if (!customerNo) {
      return {
        success: false,
        status: "FAILED",
        errorMessage: "缺少拓客系统商户号，无法查询拉卡拉审核状态",
        raw: {},
      };
    }
    // 字段定义将鉴权机构明确为 org_code；页面示例中的 open_org_code 与定义冲突。
    // 进件时已使用 org_code，查询必须使用同一机构字段才能匹配商户归属。
    const raw = await postTkbsEncrypted("/api/v3/tkbs/open_merchant_info", {
      merchant_no: null,
      customer_no: customerNo,
      org_code: getOrgCode(),
    });
    const data = responseData(raw);
    const customer = data.customer && typeof data.customer === "object"
      ? data.customer as Record<string, unknown>
      : data;
    const customerStatus = typeof customer.customer_status === "string" ? customer.customer_status : "";
    const auditRemark = typeof customer.audit_remark === "string" ? customer.audit_remark : undefined;
    const merchantNo = typeof customer.merchant_no === "string" ? customer.merchant_no : undefined;
    const innerCustomerNo = customer.customer_no === undefined || customer.customer_no === null ? undefined : String(customer.customer_no);
    const terminalNo = extractTerminalNoFromOpenMerchantInfo(data);
    return {
      success: isSuccess(raw),
      status: customerStatus === "OPEN" ? "SUCCESS" : customerStatus === "REJECT" || customerStatus === "REVIEW_FAIL" ? "FAILED" : "REGISTERING",
      merchantNo,
      innerCustomerNo,
      terminalNo,
      errorCode: String(raw.code || raw.retCode || ""),
      errorMessage: auditRemark || (isSuccess(raw) ? undefined : errorMessage(raw)),
      raw,
    };
  }
  const raw = await post("/querySubMerInfo", input as Record<string, unknown>);
  return {
    success: isSuccess(raw),
    status: isSuccess(raw) ? "SUCCESS" : "FAILED",
    errorCode: String(raw.code || raw.retCode || ""),
    errorMessage: errorMessage(raw),
    raw,
  };
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function extractTerminalNoFromOpenMerchantInfo(data: Record<string, unknown>) {
  const customer = data.customer && typeof data.customer === "object" ? data.customer as Record<string, unknown> : {};
  const pos = data.pos && typeof data.pos === "object" ? data.pos as Record<string, unknown> : {};
  const direct = firstString(customer.term_no, customer.termNo, pos.term_no, pos.termNo);
  if (direct) return direct;

  const terminalInfo = data.terminal_info;
  const terminalRows = Array.isArray(terminalInfo) ? terminalInfo : terminalInfo && typeof terminalInfo === "object" ? [terminalInfo] : [];
  for (const row of terminalRows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const rowTerm = firstString(record.term_no, record.termNo);
    if (rowTerm) return rowTerm;

    const termNoList = record.term_no_list;
    if (Array.isArray(termNoList)) {
      const term = firstString(...termNoList);
      if (term) return term;
    }

    const activeNoList = record.active_no_vo_list;
    if (Array.isArray(activeNoList)) {
      for (const item of activeNoList) {
        if (!item || typeof item !== "object") continue;
        const term = firstString((item as Record<string, unknown>).term_no, (item as Record<string, unknown>).termNo);
        if (term) return term;
      }
    }
  }
  return undefined;
}

export async function lakalaQueryBanks(input: { areaCode: string; bankName: string }): Promise<{ success: boolean; banks: LakalaBankOption[]; errorMessage?: string; raw: Record<string, unknown> }> {
  if (!input.areaCode) {
    return { success: false, banks: [], errorMessage: "缺少结算账户所在城市的拉卡拉地区码", raw: {} };
  }
  if (getLakalaOnboardingClientMode() !== "real") {
    return { success: true, banks: [], raw: { code: "000000", msg: "mock bank query success", resp_data: [] } };
  }

  // 银行列表文档没有标记 SM4 加密，和文件上传一样使用签名后的公共报文。
  const raw = await post("/api/v3/tkbs/bank", tkbsEnvelope({
    org_code: getOrgCode(),
    area_code: input.areaCode,
    bank_name: input.bankName,
  }));
  const rows = Array.isArray(raw.resp_data) ? raw.resp_data : [];
  const banks = rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const branchBankNo = typeof row.branch_bank_no === "string" ? row.branch_bank_no : "";
    const clearNo = typeof row.clear_no === "string" ? row.clear_no : "";
    const branchBankName = typeof row.branch_bank_name === "string" ? row.branch_bank_name : "";
    const areaCode = input.areaCode;
    const bankNo = typeof row.bank_no === "string" ? row.bank_no : "";
    return branchBankNo && clearNo && branchBankName ? [{ branchBankNo, clearNo, branchBankName, areaCode, bankNo }] : [];
  });
  return { success: isSuccess(raw), banks, errorMessage: isSuccess(raw) ? undefined : errorMessage(raw), raw };
}

export async function lakalaQueryChannelSubMerchants(input: { merchantNo: string }): Promise<ChannelSubMerchantResult> {
  if (!input.merchantNo) return { success: false, wechat: [], alipay: [], errorMessage: "缺少银联商户号", raw: {} };
  const raw = getLakalaOnboardingClientMode() === "real"
    ? await postTkbsEncrypted("/api/v3/tkbs/open_merchant_submer", { merchant_no: input.merchantNo, org_code: getOrgCode() })
    : { code: "000000", msg: "mock sub merchant query", resp_data: { wx_list: [], zfb_list: [] } };
  const data = responseData(raw);
  const map = (value: unknown) => Array.isArray(value) ? value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const subMerchantNo = typeof row.sub_merchant_no === "string" ? row.sub_merchant_no : "";
    return subMerchantNo ? [{ subMerchantNo, registerType: String(row.register_type || row.type || ""), channelId: String(row.channel_id || ""), registerChannelName: String(row.register_channel_name || "") }] : [];
  }) : [];
  return { success: isSuccess(raw), wechat: map(data.wx_list || data.wXList), alipay: map(data.zfb_list || data.zFBList), errorCode: String(raw.code || raw.retCode || ""), errorMessage: isSuccess(raw) ? undefined : errorMessage(raw), raw };
}

export async function lakalaQueryRegisterStatus(input: { merchantNo: string; registerType: "WXZF" | "ZFBZF" }): Promise<ChannelCertificationResult> {
  if (!input.merchantNo) return { success: false, registerType: input.registerType, errorMessage: "缺少银联商户号", raw: {} };
  const raw = getLakalaOnboardingClientMode() === "real"
    ? await postTkbsEncrypted("/api/v3/tkbs/open_merchant_register_status_query", {
      org_code: getOrgCode(),
      merchant_no: input.merchantNo,
      register_type: input.registerType,
    })
    : {
      code: "000000",
      msg: "mock register status query",
      resp_data: {
        register_state: "SUCCESS",
        authorize_state: "SUCCESS",
        register_code: "000000",
        register_msg: "成功",
        merchant_no: input.merchantNo,
        sub_mch_id: input.registerType === "WXZF" ? "910000000" : "2088000000000000",
      },
    };
  const data = responseData(raw);
  return {
    success: isSuccess(raw),
    registerType: input.registerType,
    subMchId: typeof data.sub_mch_id === "string" ? data.sub_mch_id : undefined,
    merchantNo: typeof data.merchant_no === "string" ? data.merchant_no : undefined,
    innerCustomerNo: typeof data.inner_customer_no === "string" ? data.inner_customer_no : undefined,
    customerName: typeof data.customer_name === "string" ? data.customer_name : undefined,
    registerState: typeof data.register_state === "string" ? data.register_state : undefined,
    authorizeState: typeof data.authorize_state === "string" ? data.authorize_state : undefined,
    applymentState: typeof data.applyment_state === "string" ? data.applyment_state : undefined,
    registerCode: typeof data.register_code === "string" ? data.register_code : undefined,
    registerMsg: typeof data.register_msg === "string" ? data.register_msg : undefined,
    rejectReason: typeof data.reject_reason === "string" ? data.reject_reason : undefined,
    applymentId: typeof data.applyment_id === "string" ? data.applyment_id : undefined,
    channelId: typeof data.channel_id === "string" ? data.channel_id : undefined,
    errorCode: String(raw.code || raw.retCode || ""),
    errorMessage: isSuccess(raw) ? undefined : errorMessage(raw),
    raw,
  };
}

export async function lakalaQueryMerchantAuthState(input: {
  merchantNo: string;
  tradeMode: "WECHAT" | "ALIPAY";
  subMerchantId: string;
}): Promise<MerchantAuthStateResult> {
  if (!input.merchantNo || !input.subMerchantId) {
    return {
      success: false,
      tradeMode: input.tradeMode,
      merchantNo: input.merchantNo,
      subMerchantId: input.subMerchantId,
      errorMessage: "缺少商户号或子商户号",
      raw: {},
    };
  }
  const reqData = {
    merchantNo: input.merchantNo,
    tradeMode: input.tradeMode,
    subMerchantId: input.subMerchantId,
  };
  const raw = getLakalaOnboardingClientMode() === "real"
    ? await post("/api/v2/mms/sme/mrchAuthStateQuery", mmsEnvelope(reqData))
    : {
      retCode: "000000",
      retMsg: "mock auth state query",
      respData: {
        subMerchantId: input.subMerchantId,
        checkResult: input.tradeMode === "WECHAT" ? "AUTHORIZE_STATE_AUTHORIZED" : "AUTHORIZED",
      },
    };
  const data = responseData(raw);
  return {
    success: isSuccess(raw),
    tradeMode: input.tradeMode,
    merchantNo: input.merchantNo,
    subMerchantId: input.subMerchantId,
    checkResult: typeof data.checkResult === "string" ? data.checkResult : undefined,
    errorCode: String(raw.code || raw.retCode || raw.respCode || raw.httpStatus || ""),
    errorMessage: isSuccess(raw) ? undefined : errorMessage(raw),
    raw,
  };
}

export async function lakalaReconsiderMerchant(input: { customerNo: string }): Promise<ReconsiderMerchantResult> {
  if (!input.customerNo) {
    return { success: false, errorMessage: "缺少拓客系统商户号，无法重新提交", raw: {} };
  }
  if (getLakalaOnboardingClientMode() !== "real") {
    return { success: true, raw: { code: "000000", msg: "mock resubmit success", resp_data: { message: "重新提交成功" } } };
  }
  const raw = await postTkbsEncrypted("/api/v3/tkbs/open_merchant_reconsider_submit", {
    customer_no: input.customerNo,
    org_code: getOrgCode(),
  });
  return {
    success: isSuccess(raw),
    errorCode: String(raw.code || raw.retCode || ""),
    errorMessage: isSuccess(raw) ? undefined : errorMessage(raw),
    raw,
  };
}

export function maskValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (key === "attContext" || key === "file_base64") return "[base64 omitted]";
  if (key === "acctNo" || key === "account_no") return value.length > 4 ? `****${value.slice(-4)}` : "****";
  if (key === "merContactMobile" || key === "shopContactMobile" || key === "contact_mobile") return value.replace(/^(\d{3})\d+(\d{4})$/, "$1****$2");
  if (key === "larIdcard" || key === "lar_id_card" || key === "account_id_card") return value.replace(/^(.{6}).+(.{4})$/, "$1********$2");
  if (key.toLowerCase().includes("key") || key.toLowerCase().includes("signature")) return "[secret omitted]";
  return value;
}

export function maskPayload<T>(payload: T): T {
  if (Array.isArray(payload)) return payload.map((item) => maskPayload(item)) as T;
  if (payload && typeof payload === "object") {
    return Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [
        key,
        SENSITIVE_KEYS.includes(key) ? maskValue(key, value) : maskPayload(value),
      ]),
    ) as T;
  }
  return payload;
}

export function getPrivateUploadRoot() {
  return path.resolve(process.env.PRIVATE_UPLOAD_DIR || (process.env.NODE_ENV === "production" ? "/tmp/fengyu-admin-private-uploads" : "./storage/private-uploads"));
}

export async function savePrivateOnboardingFile(applicationId: string, file: UploadFileLike) {
  const uploadRoot = getPrivateUploadRoot();
  const dir = path.join(uploadRoot, "lakala-onboarding", applicationId);
  await mkdir(dir, { recursive: true });
  const originalName = file.name || "upload.bin";
  const fileExt = originalName.includes(".") ? originalName.split(".").pop()?.toLowerCase() || "bin" : "bin";
  const fileName = `${Date.now()}-${randomBytes(6).toString("hex")}.${fileExt}`;
  const fullPath = path.join(dir, fileName);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(fullPath, buffer);
  return {
    fullPath,
    fileName: originalName,
    fileExt,
    fileSize: buffer.byteLength,
    mimeType: file.type || "application/octet-stream",
    buffer,
  };
}

export function minimalPdf(text: string) {
  const escaped = text.replace(/[()\\]/g, "\\$&").replace(/\n/g, ") Tj T* (");
  const stream = `BT /F1 12 Tf 72 760 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream endobj`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${object}\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

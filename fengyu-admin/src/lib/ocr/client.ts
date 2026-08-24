import "server-only";
import OcrApi20210707, * as $ocr from "@alicloud/ocr-api20210707";
import * as $OpenApi from "@alicloud/openapi-client";
import * as $Util from "@alicloud/tea-util";
import { Readable } from "stream";
import type { BusinessLicenseOcrResult, IdCardOcrResult } from "./types";
import type { UploadFileLike } from "@/lib/upload-file";
import { lakalaMerchantAreaCodeFromAddress } from "@/lib/lakala-merchant-area";

function ocrMode() {
  return process.env.ALIYUN_OCR_MODE === "real" ? "real" : "mock";
}

function formatDate(value?: string) {
  if (!value) return undefined;
  if (/长期|永久/i.test(value)) return undefined;
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length >= 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return value;
}

function dateRange(value?: string) {
  if (!value) return {};
  const normalized = value.replace(/年|月/g, ".").replace(/日/g, "");
  const matches = normalized.match(/\d{4}[./-]\d{1,2}[./-]\d{1,2}/g) ?? [];
  return {
    start: formatDate(matches[0]),
    end: formatDate(matches[1]),
    longTerm: isLongTerm(value),
  };
}

function isLongTerm(value?: string) {
  return value && /长期|永久/i.test(value) ? "true" : undefined;
}

function createClient() {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    throw new Error("请先配置 ALIYUN_ACCESS_KEY_ID 和 ALIYUN_ACCESS_KEY_SECRET");
  }
  const config = new $OpenApi.Config({
    accessKeyId,
    accessKeySecret,
  });
  config.endpoint = process.env.ALIYUN_OCR_ENDPOINT || "ocr-api.cn-hangzhou.aliyuncs.com";
  return new OcrApi20210707(config);
}

function runtimeOptions() {
  const readTimeout = Number(process.env.ALIYUN_OCR_READ_TIMEOUT_MS || 20000);
  const connectTimeout = Number(process.env.ALIYUN_OCR_CONNECT_TIMEOUT_MS || 10000);
  return new $Util.RuntimeOptions({
    readTimeout,
    connectTimeout,
    autoretry: true,
    maxAttempts: 2,
  });
}

async function withOcrRetry<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/timeout|ReadTimeout|ConnectTimeout/i.test(message)) throw error;
    return operation();
  }
}

function bodyToRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0])) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function valueByKey(raw: Record<string, unknown>, key: string) {
  if (key in raw) return raw[key];
  const found = Object.keys(raw).find((item) => item.toLowerCase() === key.toLowerCase());
  return found ? raw[found] : undefined;
}

function pick(raw: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = valueByKey(raw, key);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function collectWordInfo(raw: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const listKey of ["prism_wordsInfo", "prismWordsInfo", "wordsInfo", "wordInfo", "items"]) {
    const value = valueByKey(raw, listKey);
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const key = pick(row, ["key", "name", "label", "字段", "fieldName"]);
      const text = pick(row, ["word", "value", "text", "content", "字段值"]);
      if (key && text) out[key] = text;
    }
  }
  return out;
}

function normalizeAliyunResult(raw: Record<string, unknown>) {
  let current: unknown = raw;
  for (let i = 0; i < 5; i += 1) {
    current = parseMaybeJson(current);
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    const record = current as Record<string, unknown>;
    const nested = valueByKey(record, "data") ?? valueByKey(record, "result") ?? valueByKey(record, "body");
    if (!nested) break;
    current = nested;
  }
  const result = current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : raw;
  return {
    ...result,
    ...collectWordInfo(result),
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nestedIdCardResult(result: Record<string, unknown>, side: "face" | "back") {
  const sideRecord = objectRecord(valueByKey(result, side));
  const sideData = objectRecord(valueByKey(sideRecord, "data"));
  return {
    ...result,
    ...sideRecord,
    ...sideData,
    ...collectWordInfo(sideRecord),
    ...collectWordInfo(sideData),
  };
}

function hasAnyValue(values: Record<string, unknown>) {
  return Object.values(values).some((value) => typeof value === "string" && value.trim());
}

export async function recognizeBusinessLicense(file: UploadFileLike): Promise<BusinessLicenseOcrResult> {
  if (ocrMode() !== "real") {
    return {
      merBlisName: "南昌凤御美容服务有限公司",
      merRegName: "南昌凤御美容服务有限公司",
      merBlis: "91360103TEST00002X",
      merRegAddr: "江西省南昌市红谷滩区会展路 999 号",
      larName: "陈小燕",
      merBlisStDt: "2021-04-15",
      merBlisExpDt: "2041-04-14",
      merBlisLongTerm: "",
      raw: { mode: "mock", fileName: file.name },
    };
  }

  const client = createClient();
  const body = Buffer.from(await file.arrayBuffer());
  const request = new $ocr.RecognizeBusinessLicenseRequest({
    body: Readable.from(body) as unknown as ReadableStream,
  });
  const response = await withOcrRetry(() => client.recognizeBusinessLicenseWithOptions(request, runtimeOptions()));
  const raw = bodyToRecord(response.body);
  const result = normalizeAliyunResult(raw);
  const name = pick(result, ["name", "companyName", "businessName", "enterpriseName", "company", "企业名称", "营业执照名称", "名称"]);
  const address = pick(result, ["address", "businessAddress", "registeredAddress", "registerAddress", "住所", "注册地址", "经营场所"]);
  const startText = pick(result, ["validPeriodStart", "validFromDate", "startDate", "validFrom", "establishDate", "RegistrationDate", "registrationDate", "成立日期", "有效期起始日期", "营业期限自"]);
  const expiryText = pick(result, ["validPeriodEnd", "validToDate", "expiryDate", "validTo", "endDate", "validPeriod", "有效期", "有效期截止日期", "营业期限至", "执照有效期"]);
  const longTerm = isLongTerm(expiryText) || (startText && !expiryText ? "true" : undefined);
  const parsed = {
    merBlisName: name,
    merRegName: name,
    merBlis: pick(result, ["creditCode", "registerNumber", "socialCreditCode", "regNum", "registrationNumber", "统一社会信用代码", "社会信用代码", "注册号"]),
    merRegAddr: address,
    merRegDistCode: lakalaMerchantAreaCodeFromAddress(address),
    larName: pick(result, ["legalPerson", "legalRepresentative", "legalPersonName", "法人", "法定代表人", "经营者"]),
    merBlisStDt: formatDate(startText),
    merBlisExpDt: formatDate(expiryText),
    merBlisLongTerm: longTerm,
    raw,
  };
  if (!hasAnyValue(parsed)) {
    throw new Error("OCR 调用成功，但暂未匹配到营业执照字段；请联系管理员查看阿里云返回格式");
  }
  return parsed;
}

export async function recognizeIdCard(file: UploadFileLike, side: "face" | "back"): Promise<IdCardOcrResult> {
  if (ocrMode() !== "real") {
    return {
      side,
      ...(side === "face"
        ? { larName: "陈小燕", larIdcard: "360102199001011234" }
        : { larIdcardStDt: "2018-06-01", larIdcardExpDt: "2038-06-01", larIdcardLongTerm: "" }),
      raw: { mode: "mock", side, fileName: file.name },
    };
  }

  const client = createClient();
  const body = Buffer.from(await file.arrayBuffer());
  const request = new $ocr.RecognizeIdcardRequest({
    body: Readable.from(body) as unknown as ReadableStream,
  });
  const response = await withOcrRetry(() => client.recognizeIdcardWithOptions(request, runtimeOptions()));
  const raw = bodyToRecord(response.body);
  const result = normalizeAliyunResult(raw);
  const idResult = nestedIdCardResult(result, side);
  const periodText = pick(idResult, ["validPeriod", "validPeriodRange", "有效期限", "证件有效期"]);
  const period = dateRange(periodText);

  const parsed = {
    side,
    larName: side === "face" ? pick(idResult, ["name", "姓名"]) : undefined,
    larIdcard: side === "face" ? pick(idResult, ["idNumber", "idNo", "num", "身份证号", "公民身份号码"]) : undefined,
    larIdcardStDt: side === "back" ? period.start || formatDate(pick(idResult, ["startDate", "issueDate", "validFrom", "签发日期", "有效期起始日期"])) : undefined,
    larIdcardExpDt: side === "back" ? period.end || formatDate(pick(idResult, ["endDate", "expiryDate", "validTo", "失效日期", "有效期截止日期"])) : undefined,
    larIdcardLongTerm: side === "back" ? period.longTerm || isLongTerm(pick(idResult, ["endDate", "expiryDate", "validTo", "失效日期", "有效期截止日期"])) : undefined,
    raw,
  };
  if (!hasAnyValue(parsed)) {
    throw new Error("OCR 调用成功，但暂未匹配到身份证字段；请联系管理员查看阿里云返回格式");
  }
  return parsed;
}

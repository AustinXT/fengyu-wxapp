export type BusinessLicenseOcrResult = {
  merBlisName?: string
  merRegName?: string
  merBlis?: string
  merRegAddr?: string
  merRegProvinceCode?: string
  merRegCityCode?: string
  merRegDistCode?: string
  larName?: string
  merBlisStDt?: string
  merBlisExpDt?: string
  merBlisLongTerm?: string
}

export type IdCardOcrResult = {
  side: 'face' | 'back'
  larName?: string
  larIdcard?: string
  larIdcardStDt?: string
  larIdcardExpDt?: string
  larIdcardLongTerm?: string
}

export class OcrConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OcrConfigurationError'
  }
}

export class OcrServiceError extends Error {
  constructor(message = 'OCR 服务调用失败，请稍后重试') {
    super(message)
    this.name = 'OcrServiceError'
  }
}


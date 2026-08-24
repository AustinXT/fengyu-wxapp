import 'server-only'

function provinceNameFromAreaLabel(label: string): string {
  return label.match(/^(.+?(?:省|自治区|市|特别行政区))/)?.[1] ?? ''
}

function cityNameFromAreaLabel(label: string): string {
  const withoutProvince = label.replace(/^.+?(?:省|自治区|特别行政区)/, '')
  return withoutProvince.match(/^(.+?(?:市|自治州|地区|盟))/)?.[1] ?? ''
}

/** 拉卡拉详细地址字段不接收省、市、区县前缀。 */
export function removeLakalaAreaPrefix(address: string, areaLabel: string): string {
  let result = address.trim()
  if (!result || !areaLabel) return result

  const provinceName = provinceNameFromAreaLabel(areaLabel)
  const cityName = cityNameFromAreaLabel(areaLabel)
  const countyName = areaLabel.replace(provinceName, '').replace(cityName, '')
  for (const part of [provinceName, cityName, countyName]) {
    if (part && result.startsWith(part)) result = result.slice(part.length).trim()
  }
  return result
}

/**
 * 交接接口限制商户详细地址最多 29 个字符。仅在存在清晰的重复分段时自动缩短，
 * 其余情况交给提交校验提示用户修正，避免静默截断门牌号。
 */
export function normalizeLakalaDetailAddress(address: string, areaLabel: string): string {
  const withoutArea = removeLakalaAreaPrefix(address, areaLabel)
  if (withoutArea.length <= 29) return withoutArea
  const firstSegment = withoutArea.split(/[、，,；;]/)[0]?.trim()
  return firstSegment && firstSegment.length >= 6 && firstSegment.length <= 29
    ? firstSegment
    : withoutArea
}

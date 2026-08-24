export interface LakalaMerchantAreaRow {
  code: string
  name: string
  parentCode: string
}

export interface LakalaMerchantAreaOption {
  value: string
  label: string
}

export interface LakalaMerchantAreaPath {
  provinceCode: string
  cityCode: string
  countyCode: string
  label: string
}

export interface LakalaMerchantAreaDirectory {
  provinceOptions: LakalaMerchantAreaOption[]
  getCityOptions: (provinceCode?: string | null) => LakalaMerchantAreaOption[]
  getCountyOptions: (cityCode?: string | null) => LakalaMerchantAreaOption[]
  getPathByCode: (code?: string | null) => LakalaMerchantAreaPath
}

export function parseLakalaMerchantAreas(text: string): LakalaMerchantAreaRow[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const [code, name, parentCode] = line.split('\t')
      return code && name ? [{ code, name, parentCode: parentCode || '' }] : []
    })
}

export function buildLakalaMerchantAreaDirectory(rows: LakalaMerchantAreaRow[]): LakalaMerchantAreaDirectory {
  const areaByCode = new Map(rows.map((row) => [row.code, row]))
  const childrenByParent = new Map<string, LakalaMerchantAreaRow[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.parentCode) ?? []
    children.push(row)
    childrenByParent.set(row.parentCode, children)
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => Number(a.code) - Number(b.code) || a.name.localeCompare(b.name, 'zh-CN'))
  }

  const toOption = (row: LakalaMerchantAreaRow): LakalaMerchantAreaOption => ({
    value: row.code,
    label: row.name.replace(/　/g, ''),
  })
  const isRootProvince = (row: LakalaMerchantAreaRow) => (
    row.code !== '1' && (row.parentCode === '1' || !areaByCode.has(row.parentCode))
  )
  const isDirectMunicipality = (row: LakalaMerchantAreaRow) => (
    row.parentCode.startsWith('99') && row.name.endsWith('市')
  )

  return {
    provinceOptions: rows.filter(isRootProvince).map(toOption),
    getCityOptions(provinceCode) {
      if (!provinceCode) return []
      const province = areaByCode.get(provinceCode)
      if (!province) return []
      if (isDirectMunicipality(province)) return [toOption(province)]
      return (childrenByParent.get(provinceCode) ?? []).map(toOption)
    },
    getCountyOptions(cityCode) {
      if (!cityCode) return []
      const city = areaByCode.get(cityCode)
      if (!city) return []
      const children = childrenByParent.get(cityCode) ?? []
      return children
        .filter((row) => row.name !== city.name || children.length === 1)
        .map(toOption)
    },
    getPathByCode(code) {
      const empty = { provinceCode: '', cityCode: '', countyCode: '', label: '' }
      if (!code) return empty
      const selected = areaByCode.get(code)
      if (!selected) return empty

      const chain: LakalaMerchantAreaRow[] = []
      const seen = new Set<string>()
      let current: LakalaMerchantAreaRow | undefined = selected
      while (current && !seen.has(current.code)) {
        seen.add(current.code)
        if (current.code !== '1') chain.push(current)
        if (!current.parentCode || current.parentCode === '1' || !areaByCode.has(current.parentCode)) break
        current = areaByCode.get(current.parentCode)
      }
      const pathRows = chain.reverse()
      const province = pathRows[0]
      const city = pathRows.length >= 3 ? pathRows[1] : province
      const county = pathRows[pathRows.length - 1]
      if (!province?.code || !city?.code || !county?.code) return empty
      return {
        provinceCode: province.code,
        cityCode: city.code,
        countyCode: county.code,
        label: pathRows.map((item) => item.name.replace(/　/g, '')).join(''),
      }
    },
  }
}

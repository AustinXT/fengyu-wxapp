"use client"

import { useState, useMemo, useRef, useEffect } from "react"
import { areaList } from "@vant/area-data"
import { Select, SelectOption } from "@/components/ui/select"

const SEPARATOR = "/"

const provinceList = Object.entries(areaList.province_list as Record<string, string>)

function getCities(provinceCode: string) {
  const prefix = provinceCode.slice(0, 2)
  return Object.entries(areaList.city_list as Record<string, string>)
    .filter(([code]) => code.startsWith(prefix))
}

function getDistricts(cityCode: string) {
  const prefix = cityCode.slice(0, 4)
  return Object.entries(areaList.county_list as Record<string, string>)
    .filter(([code]) => code.startsWith(prefix))
}


function findCode(list: [string, string][], name: string): string {
  return list.find(([, n]) => n === name)?.[0] ?? ""
}

function parseValue(value: string | null | undefined) {
  const parts = (value ?? "").split(SEPARATOR)
  const pName = parts[0] || ""
  const cName = parts[1] || ""
  const dName = parts[2] || ""
  const pCode = pName ? findCode(provinceList, pName) : ""
  const cCode = pCode && cName ? findCode(getCities(pCode), cName) : ""
  return { pCode, cCode, dName }
}

interface RegionSelectProps {
  
  value?: string | null
  
  name?: string
}

export function RegionSelect({ value, name }: RegionSelectProps) {
  const init = parseValue(value)
  const [provinceCode, setProvinceCode] = useState(init.pCode)
  const [cityCode, setCityCode] = useState(init.cCode)
  const [districtName, setDistrictName] = useState(init.dName)
  const hiddenRef = useRef<HTMLInputElement>(null)

  const cities = useMemo(() => (provinceCode ? getCities(provinceCode) : []), [provinceCode])
  const districts = useMemo(() => (cityCode ? getDistricts(cityCode) : []), [cityCode])

  const pName = provinceCode ? (areaList.province_list as Record<string, string>)[provinceCode] ?? "" : ""
  const cName = cityCode ? (areaList.city_list as Record<string, string>)[cityCode] ?? "" : ""

  const computedValue = pName && cName && districtName
    ? `${pName}${SEPARATOR}${cName}${SEPARATOR}${districtName}`
    : ""

  
  useEffect(() => {
    if (hiddenRef.current) hiddenRef.current.value = computedValue
  }, [computedValue])

  return (
    <div className="grid grid-cols-3 gap-2">
      {name && <input type="hidden" ref={hiddenRef} name={name} defaultValue={computedValue} />}

      <Select
        defaultValue={provinceCode}
        key={`p-${init.pCode}`}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
          setProvinceCode(e.target.value)
          setCityCode("")
          setDistrictName("")
        }}
        placeholder="请选择省"
      >
        {provinceList.map(([code, n]) => (
          <SelectOption key={code} value={code}>{n}</SelectOption>
        ))}
      </Select>

      <Select
        key={`c-${provinceCode}`}
        defaultValue={cityCode}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
          setCityCode(e.target.value)
          setDistrictName("")
        }}
        placeholder="请选择市"
        disabled={!provinceCode}
      >
        {cities.map(([code, n]) => (
          <SelectOption key={code} value={code}>{n}</SelectOption>
        ))}
      </Select>

      <Select
        key={`d-${cityCode}`}
        defaultValue={districtName}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
          setDistrictName(e.target.value)
        }}
        placeholder="请选择区"
        disabled={!cityCode}
      >
        {districts.map(([code, n]) => (
          <SelectOption key={code} value={n}>{n}</SelectOption>
        ))}
      </Select>
    </div>
  )
}

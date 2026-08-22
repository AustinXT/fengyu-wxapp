import { areaList } from "@vant/area-data";

type AreaTuple = {
  value: string;
  label: string;
  province: string;
  city: string;
  county: string;
};

const provinceList = areaList.province_list as Record<string, string>;
const cityList = areaList.city_list as Record<string, string>;
const countyList = areaList.county_list as Record<string, string>;

function cityCodeOf(countyCode: string) {
  return `${countyCode.slice(0, 4)}00`;
}

function provinceCodeOf(countyCode: string) {
  return `${countyCode.slice(0, 2)}0000`;
}

function compact(value: string) {
  return value.replace(/\s+/g, "");
}

function areaTuples(): AreaTuple[] {
  return Object.entries(countyList).map(([value, county]) => {
    const province = provinceList[provinceCodeOf(value)] ?? "";
    const city = cityList[cityCodeOf(value)] ?? "";
    return {
      value,
      province,
      city,
      county,
      label: `${province}${city}${county}`,
    };
  });
}

export function getProvinceOptions() {
  return Object.entries(provinceList).map(([value, label]) => ({ value, label }));
}

export function getCityOptions(provinceCode?: string | null) {
  if (!provinceCode) return [];
  const prefix = provinceCode.slice(0, 2);
  return Object.entries(cityList)
    .filter(([value]) => value.startsWith(prefix))
    .map(([value, label]) => ({ value, label }));
}

export function getCountyOptions(cityCode?: string | null) {
  if (!cityCode) return [];
  const prefix = cityCode.slice(0, 4);
  return Object.entries(countyList)
    .filter(([value]) => value.startsWith(prefix))
    .map(([value, label]) => ({ value, label }));
}

export function getAreaPathByCode(code?: string | null) {
  if (!code) return { provinceCode: "", cityCode: "", countyCode: "", label: "" };
  const county = countyList[code] ?? "";
  if (!county) return { provinceCode: "", cityCode: "", countyCode: "", label: "" };
  const provinceCode = provinceCodeOf(code);
  const cityCode = cityCodeOf(code);
  const province = provinceList[provinceCode] ?? "";
  const city = cityList[cityCode] ?? "";
  return {
    provinceCode,
    cityCode,
    countyCode: code,
    label: `${province}${city}${county}`,
  };
}

export function getAreaCodeOptions() {
  return areaTuples().map(({ value, label }) => ({ value, label }));
}

export function areaCodeFromAddress(address?: string | null) {
  if (!address) return undefined;
  const text = compact(address);
  if (!text) return undefined;

  const candidates = areaTuples()
    .map((area) => {
      const full = compact(area.label);
      const provinceCityCounty = compact(`${area.province}${area.city}${area.county}`);
      const cityCounty = compact(`${area.city}${area.county}`);
      let score = 0;
      if (text.includes(full) || text.includes(provinceCityCounty)) score = 4;
      else if (area.province && area.city && area.county && text.includes(area.province) && text.includes(area.city) && text.includes(area.county)) score = 3;
      else if (area.city && area.county && text.includes(cityCounty)) score = 3;
      else if (area.city && area.county && text.includes(area.city) && text.includes(area.county)) score = 2;
      else if (area.county && text.includes(area.county)) score = 1;
      return { ...area, score };
    })
    .filter((area) => area.score > 0)
    .sort((a, b) => b.score - a.score || b.label.length - a.label.length);

  const best = candidates[0];
  if (!best) return undefined;

  if (best.score > 1) return best.value;
  const sameCountyMatches = candidates.filter((area) => area.score === 1 && area.county === best.county);
  return sameCountyMatches.length === 1 ? best.value : undefined;
}

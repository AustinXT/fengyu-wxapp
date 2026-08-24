export type BusinessLicenseOcrResult = {
  merBlisName?: string;
  merRegName?: string;
  merBlis?: string;
  merRegAddr?: string;
  merRegDistCode?: string;
  larName?: string;
  merBlisStDt?: string;
  merBlisExpDt?: string;
  merBlisLongTerm?: string;
  raw?: unknown;
};

export type IdCardOcrResult = {
  side: "face" | "back";
  larName?: string;
  larIdcard?: string;
  larIdcardStDt?: string;
  larIdcardExpDt?: string;
  larIdcardLongTerm?: string;
  raw?: unknown;
};

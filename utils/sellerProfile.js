"use strict";

// ISO 3166-1 alpha-2 codes. Store stable country codes rather than
// free-form country names so future carrier integrations can map regions safely.
const COUNTRY_CODES = new Set(`AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(" "));
const CURRENCIES = new Set(["NGN", "USD", "GBP", "EUR"]); // Existing product currencies.

function cleanText(value, max, min = 1) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const cleaned = value.trim().replace(/ {2,}/g, " ");
  return cleaned.length >= min && cleaned.length <= max ? cleaned : null;
}

function normalizeSellerProfile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Enter your business location and country." };
  }
  const countryCode = typeof raw.country_code === "string"
    ? raw.country_code.trim().toUpperCase() : "";
  if (!COUNTRY_CODES.has(countryCode)) {
    return { ok: false, message: "Select a valid operating country." };
  }
  const businessCity = cleanText(raw.business_city, 120, 2);
  if (!businessCity) {
    return { ok: false, message: "Enter a valid business city or town." };
  }
  const businessName = raw.business_name == null || raw.business_name === ""
    ? "" : cleanText(raw.business_name, 150);
  if (businessName === null) {
    return { ok: false, message: "Enter a valid business name (or leave it blank)." };
  }
  const businessRegion = raw.business_region == null || raw.business_region === ""
    ? "" : cleanText(raw.business_region, 120);
  if (businessRegion === null) {
    return { ok: false, message: "Enter a valid state or region." };
  }
  if (countryCode === "NG" && !businessRegion) {
    return { ok: false, message: "Enter the state for a business operating in Nigeria." };
  }
  const currency = typeof raw.preferred_currency === "string"
    ? raw.preferred_currency.trim().toUpperCase() : "";
  if (!CURRENCIES.has(currency)) {
    return { ok: false, message: "Select NGN, USD, GBP or EUR as your preferred currency." };
  }
  return {
    ok: true,
    profile: {
      business_name: businessName,
      country_code: countryCode,
      business_city: businessCity,
      business_region: businessRegion,
      preferred_currency: currency
    }
  };
}

module.exports = { normalizeSellerProfile, COUNTRY_CODES, CURRENCIES };

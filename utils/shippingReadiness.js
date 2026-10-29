"use strict";

const { COUNTRY_CODES } = require("./sellerProfile");

// Match seller-provided pickup country names to stable ISO country codes.
// This never validates the address with a carrier or declares a country shippable.
function countryKey(value) {
  return String(value || "").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const names = new Map();
const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
for (const code of COUNTRY_CODES) {
  names.set(countryKey(code), code);
  names.set(countryKey(displayNames.of(code)), code);
}
for (const [name, code] of Object.entries({
  "United States of America": "US", USA: "US", UK: "GB",
  "Great Britain": "GB", UAE: "AE", "Cote d'Ivoire": "CI",
  "Ivory Coast": "CI", "Republic of Korea": "KR",
  "South Korea": "KR", "The Netherlands": "NL"
})) names.set(countryKey(name), code);

function pickupCountryCode(value) {
  return typeof value === "string" ? names.get(countryKey(value)) || null : null;
}

function buildShippingReadiness(profile, pickup) {
  const origin = profile?.country_code || null;
  const pickupCode = pickup ? pickupCountryCode(pickup.country) : null;
  const match = origin && pickup ? origin === pickupCode : null;
  let status = "awaiting_courier_integration";
  if (!origin) status = "missing_business_profile";
  else if (!pickup) status = "missing_pickup_address";
  else if (!match) status = "pickup_country_mismatch";

  // Important: these fields are deliberately always false. They are NOT
  // carrier coverage claims and must not be used as checkout authorization.
  return {
    status,
    origin_country_code: origin,
    pickup_country_code: pickupCode,
    pickup_matches_profile: match,
    business_profile_saved: Boolean(profile),
    pickup_address_saved: Boolean(pickup),
    courier_bookings_enabled: false,
    shipping_checkout_enabled: false,
    international_payouts_enabled: false
  };
}

module.exports = { pickupCountryCode, buildShippingReadiness };

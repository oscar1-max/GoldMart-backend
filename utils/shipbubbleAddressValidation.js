"use strict";

// Admin-only shipping address validation. Never store or log submitted contact data.
function normalizeAddressInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const address = typeof body.address === "string" ? body.address.trim() : "";

  if (name.length < 2 || name.length > 120 ||
      email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      phone.length > 23 || !/^\+?[0-9][0-9 ()-]{6,21}$/.test(phone) ||
      address.length < 12 || address.length > 350 ||
      body.confirm_validation_charge !== true) {
    return null;
  }
  return { name, email, phone, address };
}

function normalizeAddressRecord(record) {
  const code = Number(record?.address_code);
  if (!Number.isSafeInteger(code) || code <= 0) return null;
  const data = record?.address_data || record || {};
  return {
    address_code: code,
    name: String(data.name || "").slice(0, 120),
    formatted_address: String(data.formatted_address || "").slice(0, 350),
    city: String(data.city || "").slice(0, 120),
    state: String(data.state || "").slice(0, 120),
    country: String(data.country || "").slice(0, 120)
  };
}

module.exports = { normalizeAddressInput, normalizeAddressRecord };

"use strict";

// Store only seller-provided pickup details. This does not contact a courier,
// validate an address with Shipbubble, book a shipment, or spend credits.
const required = [
  ["contact_name", 120, 2],
  ["contact_email", 254, 5],
  ["contact_phone", 24, 7],
  ["address_line1", 300, 8],
  ["city", 120, 2],
  ["country", 100, 2],
];
const optional = [
  ["address_line2", 200],
  ["state", 120],
  ["postal_code", 32],
];

function cleanText(value, max, min = 1) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const trimmed = value.trim().replace(/ {2,}/g, " ");
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

function normalizePickupAddress(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Enter the pickup address and contact details." };
  }

  const address = {};
  for (const [key, max, min] of required) {
    const value = cleanText(raw[key], max, min);
    if (!value) return { ok: false, message: "Enter a valid " + key.replace(/_/g, " ") + "." };
    address[key] = value;
  }
  for (const [key, max] of optional) {
    if (raw[key] == null || raw[key] === "") {
      address[key] = "";
    } else {
      const value = cleanText(raw[key], max, 1);
      if (value === null) return { ok: false, message: "Enter a valid " + key.replace(/_/g, " ") + "." };
      address[key] = value;
    }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.contact_email)) {
    return { ok: false, message: "Enter a valid contact email." };
  }
  if (!/^\+?[0-9 ()-]+$/.test(address.contact_phone) ||
      !/^\d{7,15}$/.test(address.contact_phone.replace(/\D/g, ""))) {
    return { ok: false, message: "Enter a valid pickup contact phone number." };
  }
  if (address.country.toLowerCase() === "nigeria" && !address.state) {
    return { ok: false, message: "Enter the state for a Nigerian pickup address." };
  }

  return { ok: true, address };
}

module.exports = { normalizePickupAddress };

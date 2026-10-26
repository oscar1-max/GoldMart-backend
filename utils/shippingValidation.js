"use strict";

// Worldwide delivery addresses: country and locality are free text so no
// destination is silently excluded by an incomplete country list.
// Shipping rates and courier coverage must still be confirmed separately.
function text(value, max) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean.length > 0 && clean.length <= max ? clean : null;
}

function optionalText(value, max) {
  if (value == null || value === "") return "";
  return typeof value === "string" && value.trim().length <= max
    ? value.trim() : null;
}

function normalizeDelivery(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Delivery address is required." };
  }
  const delivery = {};
  for (const [key, max] of [
    ["firstName", 150], ["lastName", 150], ["email", 150],
    ["phone", 150], ["address", 500], ["city", 150], ["country", 100],
  ]) {
    delivery[key] = text(raw[key], max);
    if (!delivery[key]) {
      return { ok: false, message: "Please enter a valid " + key + "." };
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(delivery.email)) {
    return { ok: false, message: "Please enter a valid delivery email." };
  }
  for (const [key, max] of [
    ["state", 150], ["postalCode", 32], ["addressLine2", 200],
  ]) {
    delivery[key] = optionalText(raw[key], max);
    if (delivery[key] === null) {
      return { ok: false, message: "Invalid delivery " + key + "." };
    }
  }
  return { ok: true, delivery };
}

function normalizeTracking(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Tracking information is required." };
  }
  const carrier = text(raw.carrier, 100);
  const trackingNumber = text(raw.trackingNumber, 120);
  const status = String(raw.status || "").trim().toLowerCase();
  if (!carrier || !trackingNumber || !["dispatched", "in_transit"].includes(status)) {
    return { ok: false, message: "Enter a carrier, tracking number and valid shipping status." };
  }
  return { ok: true, tracking: { carrier, trackingNumber, status } };
}

module.exports = { normalizeDelivery, normalizeTracking };

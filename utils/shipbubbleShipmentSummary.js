"use strict";

// Only public operational metadata is returned to the GoldMart admin.
// Never pass Shipbubble ship_from/ship_to, contacts, parcel contents,
// rider details, raw events, or untrusted URLs to the browser.
const STATUSES = new Set(["pending","confirmed","picked_up","in_transit","completed","cancelled"]);
function shortText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function safeTrackingUrl(value) {
  if (typeof value !== "string" || value.length > 1000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        !url.hostname || url.hostname === "localhost" ||
        /(^|\.)(localhost|local|internal)$/.test(url.hostname)) return null;
    return url.href;
  } catch (_) { return null; }
}
function normalizeShipment(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const orderId = shortText(record.order_id, 80);
  if (!orderId || !/^[A-Za-z0-9_-]+$/.test(orderId)) return null;
  const status = shortText(record.status, 32).toLowerCase();
  const courier = record.courier && typeof record.courier === "object" ? record.courier : {};
  return {
    provider_order_id: orderId,
    status: STATUSES.has(status) ? status : "unknown",
    courier_name: shortText(courier.name, 100) || null,
    tracking_code: shortText(courier.tracking_code, 120) || null,
    tracking_url: safeTrackingUrl(record.tracking_url),
    created_at: typeof record.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(record.date)
      ? record.date.slice(0, 32) : null
  };
}
module.exports = { normalizeShipment, safeTrackingUrl };

"use strict";

// The live key is only read server-side. No shipment creation or wallet debit
// is performed by this module. Keep the base URL fixed to prevent SSRF.
const BASE_URL = "https://api.shipbubble.com/v1";

class ShipbubbleError extends Error {
  constructor(message, httpStatus = 502) {
    super(message);
    this.name = "ShipbubbleError";
    this.httpStatus = httpStatus;
  }
}

function liveKey() {
  const key = String(process.env.SHIPBUBBLE_LIVE_API_KEY || "").trim();
  if (!key.startsWith("sb_prod_")) {
    throw new ShipbubbleError("Shipbubble live API is not configured correctly.", 503);
  }
  return key;
}

async function request(path, options = {}) {
  const key = liveKey();
  let response;
  try {
    response = await fetch(BASE_URL + path, {
      method: options.method || "GET",
      headers: {
        Authorization: "Bearer " + key,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    throw new ShipbubbleError(
      error && error.name === "TimeoutError"
        ? "Shipping provider timed out. Please try again."
        : "Shipping provider could not be reached.",
      error && error.name === "TimeoutError" ? 504 : 502
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    throw new ShipbubbleError("Shipping provider returned an invalid response.");
  }
  if (!response.ok || payload?.status !== "success") {
    // Never reflect provider error text, which could contain customer details.
    const status = response.status === 401 || response.status === 403 ? 503
      : response.status === 429 ? 429 : 502;
    throw new ShipbubbleError(
      status === 503 ? "Shipping provider credentials or permissions need attention."
        : status === 429 ? "Shipping provider is busy. Try again later."
          : "Shipping provider could not complete this request.",
      status
    );
  }
  return payload.data;
}

function formatRate(rate) {
  const price = Number(rate?.rate_card_amount);
  const currency = String(rate?.rate_card_currency || "").trim().toUpperCase();
  if (!Number.isFinite(price) || price < 0 || !/^[A-Z]{3}$/.test(currency)) {
    return null; // never invent a delivery price
  }
  const serviceType = String(rate.service_type || "").toLowerCase();
  return {
    courier_id: rate.courier_id,
    courier_name: String(rate.courier_name || "").slice(0, 120),
    service_code: String(rate.service_code || "").slice(0, 100),
    service_type: serviceType === "pickup" || serviceType === "dropoff" ? serviceType : "unknown",
    price,
    currency,
    delivery_eta: typeof rate.delivery_eta === "string" ? rate.delivery_eta.slice(0, 160) : null,
    pickup_eta: typeof rate.pickup_eta === "string" ? rate.pickup_eta.slice(0, 160) : null,
    insurance_available: Boolean(rate.insurance && rate.insurance.code && rate.insurance.code !== "not available"),
    tracking_level: Number.isFinite(Number(rate.tracking_level)) ? Number(rate.tracking_level) : null,
    dropoff_station: serviceType === "dropoff" && rate.dropoff_station
      ? { name: String(rate.dropoff_station.name || "").slice(0, 120),
          address: String(rate.dropoff_station.address || "").slice(0, 300) }
      : null,
  };
}

module.exports = { request, formatRate, ShipbubbleError };

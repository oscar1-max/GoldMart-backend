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

// Shipbubble's documented failed responses contain message and errors[].
// Convert them into fixed, safe guidance; never send or log raw provider text
// because it could echo a customer's address, email, or phone.
function classifyAddressValidationFailure(httpStatus, payload) {
  if (httpStatus === 401 || httpStatus === 403) {
    return new ShipbubbleError("Shipbubble API access is not authorized for address validation. Check the live API key and API access settings.", 503);
  }
  if (httpStatus === 429) {
    return new ShipbubbleError("Shipbubble is limiting address validations. Please try again later.", 429);
  }
  if (httpStatus >= 500) {
    return new ShipbubbleError("Shipbubble address validation is temporarily unavailable. Please try again later.", 502);
  }
  const parts = [
    typeof payload?.message === "string" ? payload.message : "",
    ...(Array.isArray(payload?.errors) ? payload.errors.filter(value => typeof value === "string").slice(0, 10) : [])
  ];
  const reason = parts.join(" ").slice(0, 1500).toLowerCase();

  if (/credit|balance|wallet|insufficient funds|top.?up|payment required/.test(reason)) {
    return new ShipbubbleError("Shipbubble may have insufficient address-validation credits or wallet balance. Check your Shipbubble account before trying again.", 422);
  }
  if (/api access|permission|unauthori[sz]ed|forbidden|account.*(blocked|suspend|restrict|disabled)/.test(reason)) {
    return new ShipbubbleError("Shipbubble has restricted address validation for this account. Check API access in Shipbubble settings.", 503);
  }
  if (/email/.test(reason) && /invalid|required|missing|incorrect|format/.test(reason)) {
    return new ShipbubbleError("Shipbubble rejected the email address. Check the email and try again.", 422);
  }
  if (/phone|mobile|telephone/.test(reason) && /invalid|required|missing|incorrect|format/.test(reason)) {
    return new ShipbubbleError("Shipbubble rejected the phone number. Use a reachable number, such as +2348012345678.", 422);
  }
  if (/full name|recipient name|name of/.test(reason) && /invalid|required|missing|incorrect|format/.test(reason)) {
    return new ShipbubbleError("Shipbubble rejected the full name. Enter the sender's or recipient's full name.", 422);
  }
  if (/address|location|street|postal|geocod|deliver/.test(reason) &&
      /invalid|required|missing|not found|could not|unable|unrecognized|unrecognised|verify|unavailable|unsupported|does not exist/.test(reason)) {
    return new ShipbubbleError("Shipbubble could not verify this address. Use a recognizable street address or landmark, plus city, state and Nigeria.", 422);
  }
  if (/invalid request parameters|invalid parameter/.test(reason)) {
    return new ShipbubbleError("Shipbubble rejected one or more fields. Check the full name, email, phone and complete street address.", 422);
  }
  return new ShipbubbleError("Shipbubble declined address validation. Check your Shipbubble account status and contact Shipbubble support if it continues.", 502);
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
    if (path === "/shipping/address/validate") {
      throw classifyAddressValidationFailure(response.status, payload);
    }
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

module.exports = { request, formatRate, ShipbubbleError, classifyAddressValidationFailure };

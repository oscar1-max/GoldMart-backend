"use strict";

// The live key is only read server-side. No shipment creation or wallet debit
// is performed by this module. Keep the base URL fixed to prevent SSRF.
const BASE_URL = "https://api.shipbubble.com/v1";
const { createSupportDiagnostic } = require("../utils/shipbubbleSupportDiagnostic");

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
// Inspect only error-related provider fields. Never expose or log their raw
// contents: they may echo names, phone numbers, emails or street addresses.
// Some provider responses nest field errors in objects rather than strings.
function addressFailureReasonText(payload) {
  const parts = [];
  function add(value, field = "", depth = 0) {
    if (depth > 3 || parts.length >= 20 || value == null) return;
    if (typeof value === "string") {
      parts.push((field + " " + value).slice(0, 300));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 12)) add(item, field, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value).slice(0, 15)) {
        if (/^(token|api_?key|authorization|headers|request|body|customer|recipient)$/i.test(key)) continue;
        add(nested, key, depth + 1);
      }
    }
  }
  if (payload && typeof payload === "object") {
    add(payload.message, "message");
    add(payload.errors, "errors");
    add(payload.error, "error");
    add(payload.detail, "detail");
    add(payload.data?.errors, "data.errors");
    add(payload.data?.message, "data.message");
  }
  return parts.join(" ").toLowerCase().slice(0, 2000);
}

function classifyAddressValidationFailure(httpStatus, payload) {
  const upstreamStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
    ? httpStatus : 0;
  // Provider status is an allowlist, not arbitrary text from the response.
  const providerStatus = payload?.status === "failed" ? "failed"
    : payload?.status === "success" ? "success" : "unknown";
  const makeError = (reasonCode, message, status) => {
    const diagnosticCode = "SB-VAL-" + upstreamStatus + "-" + reasonCode;
    // Existing admin UI already displays the message. Make unknown failures
    // actionable without requiring a frontend change or exposing raw data.
    const safeMessage = reasonCode === "UNKNOWN"
      ? message + " Support code: " + diagnosticCode + "." : message;
    const error = new ShipbubbleError(safeMessage, status);
    error.diagnosticCode = diagnosticCode;
    error.providerHttpStatus = upstreamStatus;
    error.providerStatus = providerStatus;
    return error;
  };

  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return makeError("API_ACCESS",
      "Shipbubble API access is not authorized for address validation. Check the live API key and API access settings.", 503);
  }
  if (upstreamStatus === 429) {
    return makeError("RATE_LIMIT",
      "Shipbubble is limiting address validations. Please try again later.", 429);
  }
  if (upstreamStatus >= 500) {
    return makeError("PROVIDER_UNAVAILABLE",
      "Shipbubble address validation is temporarily unavailable. Please try again later.", 502);
  }

  const reason = addressFailureReasonText(payload);
  if (upstreamStatus === 402 || /credit|balance|wallet|insufficient funds|top.?up|payment required|not enough funds/.test(reason)) {
    return makeError("CREDITS_OR_PAYMENT",
      "Shipbubble may require validation credits or wallet funds. Check with Shipbubble before funding your wallet.", 422);
  }
  if (/\bkyc\b|know your customer|account.*(not verified|not approved|verification pending)|complete.*verification/.test(reason)) {
    return makeError("KYC_OR_VERIFICATION",
      "Shipbubble reports an account verification restriction. Ask support to confirm live API verification status.", 503);
  }
  if (/api access|permission|unauthori[sz]ed|forbidden|account.*(blocked|suspend|restrict|disabled)/.test(reason)) {
    return makeError("ACCOUNT_ACCESS",
      "Shipbubble has restricted address validation for this account. Check API access in Shipbubble settings.", 503);
  }
  if (/email/.test(reason) && /invalid|required|missing|incorrect|format|not valid/.test(reason)) {
    return makeError("INVALID_EMAIL",
      "Shipbubble rejected the email address. Check the email and try again.", 422);
  }
  if (/phone|mobile|telephone/.test(reason) && /invalid|required|missing|incorrect|format|not valid/.test(reason)) {
    return makeError("INVALID_PHONE",
      "Shipbubble rejected the phone number. Use a reachable number, such as +2348012345678.", 422);
  }
  if (/full name|recipient name|name of/.test(reason) && /invalid|required|missing|incorrect|format|not valid/.test(reason)) {
    return makeError("INVALID_NAME",
      "Shipbubble rejected the full name. Enter the sender's or recipient's full name.", 422);
  }
  if (/address|location|street|postal|geocod|deliver|landmark/.test(reason) &&
      /invalid|required|missing|not found|could not|couldn't|unable|unrecognized|unrecognised|verify|validat|unavailable|unsupported|does not exist|no match|no result|not serviceable|not deliverable/.test(reason)) {
    return makeError("ADDRESS_NOT_VERIFIED",
      "Shipbubble could not verify this address. Use a recognizable street address or landmark, plus city, state and Nigeria.", 422);
  }
  if (/invalid request parameters|invalid parameter|invalid request body/.test(reason)) {
    return makeError("INVALID_PARAMETERS",
      "Shipbubble rejected one or more fields. Check the full name, email, phone and complete street address.", 422);
  }
  if (upstreamStatus === 404) {
    return makeError("ENDPOINT_NOT_FOUND",
      "Shipbubble did not find the address validation endpoint. Ask Shipbubble support to check API availability.", 502);
  }
  return makeError("UNKNOWN",
    "Shipbubble declined address validation. The exact reason was not recognized; share the support code with Shipbubble.", 502);
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
      const error = classifyAddressValidationFailure(response.status, payload);
      // Attach a redacted snapshot to the error object only for the requesting admin.
      // Do not log/store upstream error text. No additional provider call is made.
      error.supportDiagnostic = createSupportDiagnostic(response.status, payload, options.body);
      throw error;
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

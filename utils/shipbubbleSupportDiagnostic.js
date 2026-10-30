"use strict";

// Deliberately conservative: Shipbubble may echo submitted and unrelated
// customer details in any free-text field or even in object keys.
// We NEVER forward raw strings, unknown keys, emails, addresses or tokens.
// This is a privacy-safe diagnostic summary, NOT the original API body.
const ALLOWED_KEYS = new Set([
  "status", "success", "code", "error_code", "status_code", "http_code",
  "message", "messages", "error", "errors", "reason", "description",
  "detail", "details", "data", "field", "param", "parameter", "type"
]);
const TEXT_KEYS = new Set(["message", "messages", "error", "errors", "reason",
  "description", "detail", "details"]);
const KNOWN_FIELDS = new Set(["address","email","phone","name","city","state",
  "country","postal_code","postcode","zip","recipient","sender","street",
  "latitude","longitude","amount","quantity"]);
const KNOWN_STATUS = new Set(["success","failed","failure","error","pending","invalid"]);
const KNOWN_TYPE = new Set(["validation_error","invalid_request","not_found",
  "unauthorized","forbidden","rate_limit","bad_request","unprocessable_entity"]);
const CODE_PATTERN = /^(?:E|ERR|SB|INVALID|MISSING|VALIDATION)_[A-Z0-9_]{2,48}$/;

const TOPICS = [
  ["address_validation", /\b(address|location|geocode|geocoding|street|postal|postcode)\b/i],
  ["contact_information", /\b(email|phone|telephone|mobile|contact)\b/i],
  ["credits_or_wallet", /\b(credit|wallet|balance|funds|payment|top.up)\b/i],
  ["account_verification", /\b(kyc|verified|verification|approval|account)\b/i],
  ["invalid_or_missing_fields", /\b(invalid|missing|required|format|parameter|field)\b/i],
  ["delivery_coverage", /\b(deliverable|delivery|serviceable|coverage|unsupported)\b/i]
];

function scrubNode(value, key = "", depth = 0) {
  if (depth > 5) return "[TRUNCATED]";
  if (value === null) return null;
  if (Array.isArray(value)) return value.slice(0, 12).map(entry => scrubNode(entry, key, depth + 1));
  if (typeof value === "object") {
    const result = {};
    let omitted = 0;
    for (const [field, child] of Object.entries(value).slice(0, 40)) {
      // Only explicit known structural keys. Never echo provider-controlled key names.
      if (!ALLOWED_KEYS.has(field)) {
        omitted++;
        continue;
      }
      result[field] = scrubNode(child, field, depth + 1);
    }
    if (Object.keys(value).length > 40) omitted += Object.keys(value).length - 40;
    if (omitted) result.omitted_private_or_unknown_fields = omitted;
    return result;
  }
  if (typeof value === "boolean") return key === "success" ? value : "[REDACTED]";
  if (typeof value === "number") {
    return (["code","status_code","http_code"].includes(key) &&
      Number.isSafeInteger(value) && value >= 100 && value <= 599) ? value : "[REDACTED]";
  }
  if (typeof value !== "string") return "[REDACTED]";
  const lower = value.trim().toLowerCase();
  if (key === "status") return KNOWN_STATUS.has(lower) ? lower : "[REDACTED]";
  if (["field", "param", "parameter"].includes(key)) {
    return KNOWN_FIELDS.has(lower) ? lower : "[REDACTED]";
  }
  if (key === "type") return KNOWN_TYPE.has(lower) ? lower : "[REDACTED]";
  if (["code", "error_code"].includes(key)) {
    return CODE_PATTERN.test(value) ? value : "[REDACTED]";
  }
  if (TEXT_KEYS.has(key)) {
    // Preserve only fixed categories, never the message or text fragments.
    // This deliberately cannot reconstruct the provider's original message.
    const topics = TOPICS.filter(([,regex]) => regex.test(value)).map(([topic]) => topic);
    return { raw_text: "[REDACTED]", detected_topics: topics };
  }
  return "[REDACTED]";
}

function createSupportDiagnostic(httpStatus, payload) {
  const safeStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
    ? httpStatus : null;
  const snapshot = JSON.stringify(scrubNode(payload));
  return {
    provider_http_status: safeStatus,
    provider_endpoint: "/v1/shipping/address/validate",
    format: "redacted_json_reconstruction",
    redaction_note: "For review only. Free-text and unknown fields are removed. This is NOT the raw API response requested by Shipbubble.",
    provider_response_redacted: snapshot.length <= 6000 ? snapshot : '{"redacted":"response_too_large"}'
  };
}

module.exports = { createSupportDiagnostic };

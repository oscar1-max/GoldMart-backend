"use strict";

// Preserve Shipbubble's error JSON structure for troubleshooting while
// redacting personal details and secrets. No raw body is logged or stored.
const PRIVATE_KEYS = /token|key|authorization|secret|password|cookie|header|request|address|email|phone|mobile|name|customer|recipient|sender|receiver|location|contact|card|bank|user/i;
const MESSAGE_KEYS = /^(message|messages|error|errors|detail|details|description|reason)$/i;
const CODE_KEYS = /^(status|code|error_code|type|field|param|parameter|status_code|http_code)$/i;

function scrubText(value, submitted = {}) {
  let output = String(value).slice(0, 600);
  const original = [submitted.name, submitted.email, submitted.phone, submitted.address];
  const fragments = [
    ...String(submitted.name || "").split(/\s+/),
    ...String(submitted.address || "").split(/,/),
  ];
  for (const item of [...original, ...fragments]) {
    const part = typeof item === "string" ? item.trim() : "";
    if (part.length < 3) continue;
    // String split is safe even for regex metacharacters; no regex injection.
    const indexOf = output.toLowerCase().indexOf(part.toLowerCase());
    if (indexOf >= 0) {
      // Replace all repeated occurrences regardless of case.
      while (output.toLowerCase().includes(part.toLowerCase())) {
        const at = output.toLowerCase().indexOf(part.toLowerCase());
        output = output.slice(0, at) + "[REDACTED]" + output.slice(at + part.length);
      }
    }
  }
  return output
    .replace(/\bBearer\s+\S+/gi, "[REDACTED]")
    .replace(/\bsb_(?:prod|test)_[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]");
}

function safeNode(value, key, submitted, depth = 0) {
  if (depth > 5) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (CODE_KEYS.test(key) && /^[a-zA-Z_][a-zA-Z0-9_.-]{0,60}$/.test(value)) return value;
    if (MESSAGE_KEYS.test(key)) return scrubText(value, submitted);
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeNode(item, key, submitted, depth + 1));
  if (typeof value !== "object" || !value) return "[REDACTED]";
  const result = {};
  for (const [name, child] of Object.entries(value).slice(0, 30)) {
    const safeName = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,60}$/.test(name) ? name : "unrecognized_field";
    result[safeName] = PRIVATE_KEYS.test(name) ? "[REDACTED]" : safeNode(child, name, submitted, depth + 1);
  }
  return result;
}

function createSupportDiagnostic(httpStatus, payload, submitted = {}) {
  return {
    provider_http_status: httpStatus,
    provider_endpoint: "/v1/shipping/address/validate",
    format: "redacted_json_reconstruction",
    redaction_note: "Review carefully before sharing. This preserves response fields but is not the original raw HTTP body.",
    provider_response_redacted: JSON.stringify(safeNode(payload, "", submitted)).slice(0, 6000),
  };
}

module.exports = { createSupportDiagnostic };

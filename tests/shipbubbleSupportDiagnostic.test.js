"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupportDiagnostic } = require("../utils/shipbubbleSupportDiagnostic");

test("preserves only safe status, error code, field and general topics", () => {
  const diagnostic = createSupportDiagnostic(400, {
    status: "failed", code: "E_INVALID_ADDRESS",
    errors: [{ field: "address", message: "Invalid address; Ada Okafor at 42 Example Street; secret +2348012345678" }],
    customer: { email: "ada@example.com", address: "42 Example Street" },
    request: { token: "sb_prod_secretsecret" }
  });
  assert.equal(diagnostic.provider_http_status, 400);
  assert.equal(diagnostic.format, "redacted_json_reconstruction");
  assert.match(diagnostic.provider_response_redacted, /E_INVALID_ADDRESS/);
  assert.match(diagnostic.provider_response_redacted, /address_validation/);
  for (const sensitive of ["Ada Okafor", "Example Street", "+2348012345678",
    "ada@example.com", "sb_prod_secretsecret"]) {
    assert.equal(JSON.stringify(diagnostic).includes(sensitive), false);
  }
});

test("never exposes unrelated people, arbitrary codes, free text or object key names", () => {
  const privateValues = [
    "Jane Smith", "9 Unknown Avenue", "private.customer@example.com",
    "+2348033333333", "my-private-token"
  ];
  const diagnostic = createSupportDiagnostic(400, {
    status: "failed", code: "JaneSmith", type: "private.customer@example.com",
    message: privateValues.join(" | "),
    "Jane Smith": { "9 Unknown Avenue": "private" },
    errors: [ "Call Jane Smith at +2348033333333", { field: "JaneSmith", reason: "See private.customer@example.com" }]
  });
  const text = JSON.stringify(diagnostic);
  for (const value of privateValues) assert.equal(text.includes(value), false, "leaked "+value);
  assert.match(text, /omitted_private_or_unknown_fields/);
});

test("redaction cannot hang when submitted data resembles a replacement token", () => {
  const diagnostic = createSupportDiagnostic(400, {
    message: "Example [REDACTED] and other private information",
    errors: ["<secret>"]
  }, { name: "[REDACTED]", address: "[REDACTED]" });
  assert.equal(diagnostic.provider_response_redacted.includes("Example"), false);
  assert.equal(diagnostic.provider_response_redacted.includes("<secret>"), false);
});

test("truncates unknown or extremely large nested responses safely", () => {
  const diagnostic = createSupportDiagnostic(400, {
    message: "Private ".repeat(10000),
    strange_key: { confidential: "Unknown" },
    data: { extra_info: "private details" }
  });
  assert.ok(diagnostic.provider_response_redacted.length <= 6000);
  assert.equal(diagnostic.provider_response_redacted.includes("Unknown"), false);
});

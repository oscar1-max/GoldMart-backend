"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupportDiagnostic } = require("../utils/shipbubbleSupportDiagnostic");

test("diagnostics preserve provider error structure while masking customer and secret fields", () => {
  const submitted = {
    name: "Ada Okafor", email: "ada.customer@example.com",
    phone: "+2348012345678", address: "42 Example Street, Awka, Nigeria"
  };
  const diagnostic = createSupportDiagnostic(400, {
    status: "failed", message: "Could not verify 42 Example Street, Awka, Nigeria for Ada Okafor",
    errors: [{ field: "address", message: "Please fix ada.customer@example.com +2348012345678" }],
    request: { token: "sb_prod_secretsecret", name: "Ada Okafor" },
    customer: { email: "ada.customer@example.com" },
    code: "E_INVALID_ADDRESS"
  }, submitted);
  const output = JSON.stringify(diagnostic);
  assert.equal(diagnostic.provider_http_status, 400);
  assert.equal(diagnostic.format, "redacted_json_reconstruction");
  assert.match(output, /E_INVALID_ADDRESS/);
  assert.match(output, /REDACTED/);
  for (const secret of [submitted.name, submitted.email, submitted.phone, submitted.address,
    "42 Example Street", "Ada", "Okafor", "sb_prod_secretsecret"]) {
    assert.equal(output.includes(secret), false, "diagnostic leaked "+secret);
  }
});

test("unknown keys do not reveal arbitrary customer content", () => {
  const diagnostic = createSupportDiagnostic(400, {
    diagnostics: { arbitrary: "someone else's private address" },
    errors: ["Invalid phone +2348012345678"],
    message: "Field required"
  });
  assert.equal(JSON.stringify(diagnostic).includes("someone else's private address"), false);
  assert.equal(JSON.stringify(diagnostic).includes("+2348012345678"), false);
});

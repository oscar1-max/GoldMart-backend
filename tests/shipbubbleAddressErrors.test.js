"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyAddressValidationFailure } = require("../services/shipbubble");

test("shows safe guidance without leaking provider customer data", () => {
  const address = "Private Home 123";
  const error = classifyAddressValidationFailure(400, { message: "Address could not be verified: " + address });
  assert.match(error.message, /could not verify/i);
  assert.equal(error.message.includes(address), false);
});

test("categorizes credits, phone, email, account access, and unknown errors", () => {
  assert.match(classifyAddressValidationFailure(402, { message: "Insufficient credits" }).message, /credits/i);
  assert.match(classifyAddressValidationFailure(400, { errors: ["phone is invalid"] }).message, /phone/i);
  assert.match(classifyAddressValidationFailure(422, { errors: ["email is required"] }).message, /email/i);
  assert.equal(classifyAddressValidationFailure(403, {}).httpStatus, 503);
  assert.equal(classifyAddressValidationFailure(429, {}).httpStatus, 429);
  assert.equal(classifyAddressValidationFailure(502, {}).httpStatus, 502);
  assert.equal(classifyAddressValidationFailure(400, { message: "Something else" }).message.includes("Something else"), false);
});


test("classifies nested provider error objects without exposing personal details", () => {
  const secret = "Private Street 23, Lagos";
  const error = classifyAddressValidationFailure(422, {
    status: "failed",
    errors: { address: ["Could not validate " + secret] }
  });
  assert.match(error.message, /could not verify/i);
  assert.equal(error.message.includes(secret), false);
  assert.equal(error.diagnosticCode, "SB-VAL-422-ADDRESS_NOT_VERIFIED");
  assert.equal(error.providerHttpStatus, 422);
});

test("returns stable privacy-safe support codes for unknown errors", () => {
  const secret = "private.customer@example.com";
  const error = classifyAddressValidationFailure(400, {
    status: "failed",
    message: "Unexpected validation response for " + secret
  });
  assert.match(error.message, /SB-VAL-400-UNKNOWN/);
  assert.equal(error.message.includes(secret), false);
  assert.equal(error.diagnosticCode, "SB-VAL-400-UNKNOWN");
});

test("recognizes provider payment status without suggesting an immediate top-up", () => {
  const error = classifyAddressValidationFailure(402, { message: "Payment needed" });
  assert.equal(error.diagnosticCode, "SB-VAL-402-CREDITS_OR_PAYMENT");
  assert.match(error.message, /before funding/i);
});

test("ignores raw customer and request fields in nested provider responses", () => {
  const error = classifyAddressValidationFailure(400, {
    errors: { request: { address: "private" }, customer: { email: "secret@example.com" } }
  });
  assert.equal(error.diagnosticCode, "SB-VAL-400-UNKNOWN");
});

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

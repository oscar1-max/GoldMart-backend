"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeDelivery, normalizeTracking } = require("../utils/shippingValidation");

const destination = {
  firstName: "Ada", lastName: "Okafor", email: "ada@example.com",
  phone: "+2348000000000", address: "42 Example Street",
  city: "Awka", country: "Nigeria", state: "Anambra",
};

test("accepts Nigerian addresses and optional details", () => {
  const result = normalizeDelivery({ ...destination, postalCode: "420001", addressLine2: "Flat 3" });
  assert.equal(result.ok, true);
  assert.equal(result.delivery.country, "Nigeria");
  assert.equal(result.delivery.postalCode, "420001");
});
test("accepts international addresses without a Nigerian state", () => {
  const result = normalizeDelivery({ ...destination, country: "Japan", city: "Tokyo", state: "", postalCode: "100-0001" });
  assert.equal(result.ok, true);
  assert.equal(result.delivery.country, "Japan");
});
test("requires a country and rejects invalid email", () => {
  assert.equal(normalizeDelivery({ ...destination, country: "" }).ok, false);
  assert.equal(normalizeDelivery({ ...destination, email: "not-email" }).ok, false);
});
test("rejects oversized address details", () => {
  assert.equal(normalizeDelivery({ ...destination, postalCode: "x".repeat(33) }).ok, false);
  assert.equal(normalizeDelivery({ ...destination, addressLine2: "x".repeat(201) }).ok, false);
});
test("accepts seller-reported dispatch tracking", () => {
  assert.deepEqual(normalizeTracking({ carrier: "DHL", trackingNumber: "ABC12345", status: "in_transit" }), {
    ok: true, tracking: { carrier: "DHL", trackingNumber: "ABC12345", status: "in_transit" }
  });
});
test("rejects fake delivery confirmation and missing carrier", () => {
  assert.equal(normalizeTracking({ carrier: "DHL", trackingNumber: "ABC12345", status: "delivered" }).ok, false);
  assert.equal(normalizeTracking({ carrier: "", trackingNumber: "ABC12345", status: "dispatched" }).ok, false);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePickupAddress } = require("../utils/sellerPickupAddress");

const valid = {
  contact_name: "Ada Okafor",
  contact_email: "ada@example.com",
  contact_phone: "+234 801 234 5678",
  address_line1: "42 Example Street",
  address_line2: "Shop 3",
  city: "Awka",
  state: "Anambra",
  country: "Nigeria",
  postal_code: "420001"
};

test("accepts and trims seller pickup details without provider validation", () => {
  const result = normalizePickupAddress({ ...valid, contact_name: "  Ada Okafor  ", seller_id: 999 });
  assert.equal(result.ok, true);
  assert.equal(result.address.contact_name, "Ada Okafor");
  assert.equal(result.address.seller_id, undefined);
  assert.equal(result.address.country, "Nigeria");
});

test("accepts international addresses without a state", () => {
  const result = normalizePickupAddress({ ...valid, country: "Japan", state: "", postal_code: "" });
  assert.equal(result.ok, true);
  assert.equal(result.address.state, "");
});

test("requires a Nigerian state and complete street address", () => {
  assert.equal(normalizePickupAddress({ ...valid, state: "" }).ok, false);
  assert.equal(normalizePickupAddress({ ...valid, address_line1: "Short" }).ok, false);
  assert.equal(normalizePickupAddress({ ...valid, city: "" }).ok, false);
});

test("rejects invalid contacts, control characters and oversized values", () => {
  assert.equal(normalizePickupAddress({ ...valid, contact_email: "invalid" }).ok, false);
  assert.equal(normalizePickupAddress({ ...valid, contact_phone: "123" }).ok, false);
  assert.equal(normalizePickupAddress({ ...valid, contact_name: "A".repeat(121) }).ok, false);
  assert.equal(normalizePickupAddress({ ...valid, address_line1: "x".repeat(301) }).ok, false);
  assert.equal(normalizePickupAddress({ ...valid, address_line2: "x".repeat(201) }).ok, false);
  assert.equal(normalizePickupAddress({ ...valid, address_line1: "42 Example\nStreet" }).ok, false);
  assert.equal(normalizePickupAddress(null).ok, false);
});

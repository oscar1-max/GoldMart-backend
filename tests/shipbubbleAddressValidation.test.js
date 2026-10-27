"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAddressInput, normalizeAddressRecord } = require("../utils/shipbubbleAddressValidation");

const valid = {
  name: "Ada Okafor",
  email: "ada@example.com",
  phone: "+2348012345678",
  address: "42 Example Street, Awka, Anambra, Nigeria",
  confirm_validation_charge: true
};

test("accepts valid address with explicit charge confirmation", () => {
  assert.deepEqual(normalizeAddressInput(valid), {
    name: valid.name, email: valid.email, phone: valid.phone, address: valid.address
  });
});

test("requires explicit consent to use Shipbubble validation credits", () => {
  assert.equal(normalizeAddressInput({ ...valid, confirm_validation_charge: false }), null);
  assert.equal(normalizeAddressInput({ ...valid, confirm_validation_charge: "true" }), null);
  assert.equal(normalizeAddressInput({ ...valid, confirm_validation_charge: undefined }), null);
});

test("rejects malformed and oversized contact data", () => {
  assert.equal(normalizeAddressInput({ ...valid, email: "bad-email" }), null);
  assert.equal(normalizeAddressInput({ ...valid, phone: "1" }), null);
  assert.equal(normalizeAddressInput({ ...valid, address: "Short" }), null);
  assert.equal(normalizeAddressInput({ ...valid, name: "X".repeat(121) }), null);
  assert.equal(normalizeAddressInput({ ...valid, address: "x".repeat(351) }), null);
});

test("only exposes safe fields and valid address codes", () => {
  assert.deepEqual(normalizeAddressRecord({
    address_code: 12345,
    name: "Ada",
    email: "secret@example.com",
    phone: "+2348012345678",
    formatted_address: "Awka, Nigeria",
    city: "Awka",
    state: "Anambra",
    country: "Nigeria"
  }), {
    address_code: 12345, name: "Ada", formatted_address: "Awka, Nigeria",
    city: "Awka", state: "Anambra", country: "Nigeria"
  });
  assert.equal(normalizeAddressRecord({ address_code: "no-code" }), null);
});

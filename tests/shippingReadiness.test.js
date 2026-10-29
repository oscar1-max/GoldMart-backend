"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { pickupCountryCode, buildShippingReadiness } = require("../utils/shippingReadiness");

test("recognizes pickup countries by name or ISO code without carrier calls", () => {
  for (const [name, code] of [
    ["Nigeria", "NG"], [" ng ", "NG"], ["United Kingdom", "GB"],
    ["UK", "GB"], ["United States", "US"], ["USA", "US"],
    ["Ghana", "GH"], ["Germany", "DE"], ["United Arab Emirates", "AE"]
  ]) assert.equal(pickupCountryCode(name), code);
  assert.equal(pickupCountryCode("Unknownland"), null);
  assert.equal(pickupCountryCode({ country: "Nigeria" }), null);
});

test("readiness is never a live shipping or payout approval", () => {
  const cases = [
    [null, null, "missing_business_profile", null],
    [{ country_code: "NG" }, null, "missing_pickup_address", null],
    [{ country_code: "NG" }, { country: "United Kingdom" }, "pickup_country_mismatch", false],
    [{ country_code: "NG" }, { country: "Nigeria" }, "awaiting_courier_integration", true],
    [{ country_code: "GB" }, { country: "UK" }, "awaiting_courier_integration", true],
    [{ country_code: "US" }, { country: "Unknownland" }, "pickup_country_mismatch", false]
  ];
  for (const [profile, pickup, status, match] of cases) {
    const r = buildShippingReadiness(profile, pickup);
    assert.equal(r.status, status);
    assert.equal(r.pickup_matches_profile, match);
    assert.equal(r.courier_bookings_enabled, false);
    assert.equal(r.shipping_checkout_enabled, false);
    assert.equal(r.international_payouts_enabled, false);
    assert.equal("address_line1" in r, false);
  }
});

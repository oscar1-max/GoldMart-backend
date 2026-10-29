"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSellerProfile, COUNTRY_CODES } = require("../utils/sellerProfile");

const nigeria = {
  business_name: "GoldMart Store",
  country_code: "NG",
  business_city: "Port Harcourt",
  business_region: "Rivers",
  preferred_currency: "NGN"
};

test("supports Nigerian sellers and ignores client seller IDs", () => {
  const result = normalizeSellerProfile({ ...nigeria, business_city: " Port Harcourt ", seller_id: 123 });
  assert.equal(result.ok, true);
  assert.equal(result.profile.business_city, "Port Harcourt");
  assert.equal(result.profile.seller_id, undefined);
});

test("supports foreign sellers with ISO country codes and existing currencies", () => {
  for (const [country_code, preferred_currency] of [
    ["GB", "GBP"], ["US", "USD"], ["GH", "USD"], ["DE", "EUR"], ["JP", "USD"]
  ]) {
    const result = normalizeSellerProfile({
      business_name: "",
      country_code: country_code.toLowerCase(),
      business_city: "London",
      business_region: "",
      preferred_currency: preferred_currency.toLowerCase()
    });
    assert.equal(result.ok, true);
    assert.equal(result.profile.country_code, country_code);
    assert.equal(result.profile.preferred_currency, preferred_currency);
  }
  assert.ok(COUNTRY_CODES.size >= 240);
});

test("rejects invalid country, currency, missing city and missing Nigerian state", () => {
  assert.equal(normalizeSellerProfile({ ...nigeria, country_code: "ZZ" }).ok, false);
  assert.equal(normalizeSellerProfile({ ...nigeria, country_code: "Nigeria" }).ok, false);
  assert.equal(normalizeSellerProfile({ ...nigeria, preferred_currency: "GHS" }).ok, false);
  assert.equal(normalizeSellerProfile({ ...nigeria, business_city: "" }).ok, false);
  assert.equal(normalizeSellerProfile({ ...nigeria, business_region: "" }).ok, false);
});

test("rejects oversized values and control characters", () => {
  assert.equal(normalizeSellerProfile({ ...nigeria, business_name: "A".repeat(151) }).ok, false);
  assert.equal(normalizeSellerProfile({ ...nigeria, business_city: "A".repeat(121) }).ok, false);
  assert.equal(normalizeSellerProfile({ ...nigeria, business_region: "A".repeat(121) }).ok, false);
  assert.equal(normalizeSellerProfile({ ...nigeria, business_name: "Test\nStore" }).ok, false);
  assert.equal(normalizeSellerProfile(null).ok, false);
});

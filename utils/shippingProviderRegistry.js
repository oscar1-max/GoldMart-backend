"use strict";

// A planning registry, not a carrier coverage database. Every provider below
// is unverified, unconnected, and incapable of making a live booking.
const CANDIDATES = Object.freeze({
  NG: [{ id: "shipbubble", name: "Shipbubble", status: "address_validation_blocked" }],
  GB: [{ id: "dhl", name: "DHL Express", status: "evaluation_only" },
       { id: "ups", name: "UPS", status: "evaluation_only" }],
  US: [{ id: "ups", name: "UPS", status: "evaluation_only" },
       { id: "fedex", name: "FedEx", status: "evaluation_only" }],
  GH: [{ id: "dhl", name: "DHL Express", status: "evaluation_only" }],
  KE: [{ id: "dhl", name: "DHL Express", status: "evaluation_only" }],
  ZA: [{ id: "dhl", name: "DHL Express", status: "evaluation_only" }],
  CA: [{ id: "ups", name: "UPS", status: "evaluation_only" }],
  DE: [{ id: "dhl", name: "DHL Express", status: "evaluation_only" }],
  FR: [{ id: "dhl", name: "DHL Express", status: "evaluation_only" }]
});

const { pickupCountryCode } = require("./shippingReadiness");

function providerOptions(origin) {
  return (CANDIDATES[origin] || []).map(candidate => ({
    ...candidate,
    connected: false,
    coverage_verified: false,
    rates_enabled: false,
    bookings_enabled: false
  }));
}

function assessRoute(seller, destination) {
  const origin = seller?.country_code || null;
  const pickup = seller?.pickup_country ? pickupCountryCode(seller.pickup_country) : null;
  let status = "awaiting_courier_integration";
  if (!origin) status = "missing_business_profile";
  else if (!seller?.pickup_country) status = "missing_pickup_address";
  else if (pickup !== origin) status = "pickup_country_mismatch";
  else if (!destination) status = "invalid_destination";
  else if (origin !== "NG" || destination !== "NG") status = "unsupported_international_route";
  else status = "nigeria_test_only";

  return {
    seller_id: seller?.seller_id ?? null,
    origin_country_code: origin,
    destination_country_code: destination,
    pickup_matches_profile: Boolean(origin && pickup === origin),
    status,
    provider_options: providerOptions(origin),
    // The only permitted checkout is existing Paystack TEST-mode NG-to-NG.
    // It has NO shipping quote, label, insurance, pickup or booking.
    test_checkout_allowed: status === "nigeria_test_only",
    shipping_checkout_enabled: false,
    courier_bookings_enabled: false,
    international_payouts_enabled: false
  };
}

function assessCartDelivery(sellers, destinationInput) {
  const destination = pickupCountryCode(destinationInput);
  const routes = Array.isArray(sellers) ? sellers.map(seller => assessRoute(seller, destination)) : [];
  const allowed = Boolean(destination && routes.length &&
    routes.every(route => route.test_checkout_allowed));
  return {
    destination_country_code: destination,
    status: !destination ? "invalid_destination" :
      !routes.length ? "empty_cart" :
      allowed ? "nigeria_test_only" : "delivery_not_supported",
    test_checkout_allowed: allowed,
    shipping_checkout_enabled: false,
    courier_bookings_enabled: false,
    international_payouts_enabled: false,
    shipping_quote_available: false,
    routes
  };
}

async function loadSellerRoutes(pool, sellerIds) {
  const ids = [...new Set((sellerIds || []).map(Number))];
  if (!ids.length) return [];
  // A cart with a missing/invalid seller must fail closed, not look empty.
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    return [{ seller_id: null, country_code: null, pickup_country: null }];
  }
  const result = await pool.query(
    "SELECT ids.seller_id, sp.country_code, spa.country AS pickup_country " +
    "FROM unnest($1::integer[]) AS ids(seller_id) " +
    "LEFT JOIN seller_profiles sp ON sp.seller_id = ids.seller_id " +
    "LEFT JOIN seller_pickup_addresses spa ON spa.seller_id = ids.seller_id",
    [ids]
  );
  return result.rows;
}

module.exports = { providerOptions, assessRoute, assessCartDelivery, loadSellerRoutes };

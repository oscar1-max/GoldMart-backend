"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeShipment, safeTrackingUrl } = require("../utils/shipbubbleShipmentSummary");

test("read-only shipment summary omits all personal and parcel information", () => {
  const summary = normalizeShipment({
    order_id: "SB-ABC123", status: "in_transit", date: "2026-10-29T13:00:00.000Z",
    courier: { name: "Courier One", tracking_code: "TRK-1", phone: "private-phone", email: "private-email" },
    tracking_url: "https://tracking.example.org/ship/TRK-1",
    ship_from: { name: "Private Sender", address: "Private Street" },
    ship_to: { email: "private@example.org", phone: "+2348011111111" },
    items: [{ name: "private parcel" }], events: [{ message: "private location" }]
  });
  assert.deepEqual(summary, {
    provider_order_id: "SB-ABC123", status: "in_transit", courier_name: "Courier One",
    tracking_code: "TRK-1", tracking_url: "https://tracking.example.org/ship/TRK-1",
    created_at: "2026-10-29T13:00:00.000Z"
  });
  const output = JSON.stringify(summary);
  for (const secret of ["Private Sender","Private Street","private@example.org","private-phone","private parcel"]) {
    assert.equal(output.includes(secret), false);
  }
});

test("invalid status, provider ids and tracking URLs fail closed", () => {
  assert.equal(normalizeShipment({ order_id: "<script>" }), null);
  assert.equal(normalizeShipment(null), null);
  assert.equal(normalizeShipment({ order_id: "SB-1", status: "refunded", tracking_url: "javascript:alert(1)" }).status, "unknown");
  for (const url of ["http://example.org", "https://localhost:5000/x", "javascript:alert(1)", "https://user:pass@example.org/x", "/relative"]) {
    assert.equal(safeTrackingUrl(url), null);
  }
  assert.equal(safeTrackingUrl("https://courier.example.org/track"), "https://courier.example.org/track");
});

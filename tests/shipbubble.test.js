"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { formatRate, request, ShipbubbleError } = require("../services/shipbubble");
test("does not invent a shipping price when provider rate is missing", () => {
  assert.equal(formatRate({courier_name:"Courier"}), null);
  assert.equal(formatRate({rate_card_amount:"12",rate_card_currency:"NGN"}).price, 12);
});
test("does not expose API secrets when live key is absent", async () => {
  const old = process.env.SHIPBUBBLE_LIVE_API_KEY;
  delete process.env.SHIPBUBBLE_LIVE_API_KEY;
  try { await assert.rejects(request("/shipping/fetch_rates"), ShipbubbleError); }
  finally { if (old === undefined) delete process.env.SHIPBUBBLE_LIVE_API_KEY; else process.env.SHIPBUBBLE_LIVE_API_KEY = old; }
});

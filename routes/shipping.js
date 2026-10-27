"use strict";
const express = require("express");
const { protect, authorize } = require("../middleware/auth");
const { request, formatRate, ShipbubbleError } = require("../services/shipbubble");
const router = express.Router();
// Admin-only live quote preview. No bookings, address validation, or wallet charges.
// Never expose the live key or accept arbitrary API paths.
router.get("/status", protect, authorize("admin"), (req, res) => {
  res.json({ success: true, provider: "shipbubble", mode: "live", configured: Boolean(process.env.SHIPBUBBLE_LIVE_API_KEY), bookings_enabled: false, checkout_enabled: false });
});
router.post("/preview-rates", protect, authorize("admin"), async (req, res) => {
  const b = req.body || {};
  const pickup = typeof b.sender_address_code === "string" ? b.sender_address_code.trim() : "";
  const delivery = typeof b.recipient_address_code === "string" ? b.recipient_address_code.trim() : "";
  const category = Number(b.category_id);
  const amount = Number(b.package_items?.[0]?.amount);
  const weight = Number(b.package_items?.[0]?.weight);
  const quantity = Number(b.package_items?.[0]?.quantity);
  const description = String(b.package_items?.[0]?.description || "").trim();
  const dimensions = [b.length,b.width,b.height].map(Number);
  const date = String(b.pickup_date || "").trim();
  const validCode = s => /^[A-Za-z0-9_-]{2,100}$/.test(s);
  if (!validCode(pickup) || !validCode(delivery) || !Number.isSafeInteger(category) || category <= 0 ||
      !Number.isFinite(amount) || amount <= 0 || amount > 100000000 ||
      !Number.isFinite(weight) || weight <= 0 || weight > 100000 ||
      !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100 ||
      !description || description.length > 150 || dimensions.some(n => !Number.isFinite(n) || n <= 0 || n > 1000) || !/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, message: "Valid verified address codes, category, one package item, and pickup date are required." });
  }
  const pickupDate = new Date(date + "T00:00:00Z");
  const today = new Date(); today.setUTCHours(0,0,0,0);
  if (Number.isNaN(pickupDate.getTime()) || pickupDate.toISOString().slice(0,10) !== date || pickupDate < today ||
      pickupDate.getTime() > today.getTime() + 30*86400000) {
    return res.status(400).json({ success: false, message: "Pickup date must be within the next 30 days." });
  }
  try {
    const data = await request("/shipping/fetch_rates", { method: "POST", body: {
      sender_address_code: pickup,
      recipient_address_code: delivery,
      pickup_date: date,
      category_id: category,
      package_items: [{ name: description, description, unit_weight: weight, unit_amount: amount, quantity }],
      package_dimension: { length: Number(b.length), width: Number(b.width), height: Number(b.height) },
    } });
    const rates = Array.isArray(data) ? data : Array.isArray(data?.couriers) ? data.couriers : [];
    return res.json({ success: true, provider: "shipbubble", live: true, bookings_enabled: false, rates: rates.map(formatRate).filter(Boolean) });
  } catch (error) {
    return res.status(error instanceof ShipbubbleError ? error.httpStatus : 502)
      .json({ success: false, message: error instanceof ShipbubbleError ? error.message : "Unable to get shipping quotations." });
  }
});
module.exports = router;

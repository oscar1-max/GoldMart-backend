"use strict";
const express = require("express");
const { protect, authorize } = require("../middleware/auth");
const { request, formatRate, ShipbubbleError } = require("../services/shipbubble");

const { normalizeAddressInput, normalizeAddressRecord } = require("../utils/shipbubbleAddressValidation");
const { normalizeShipment } = require("../utils/shipbubbleShipmentSummary");

const router = express.Router();
const addressValidationCooldown = new Map();
// Admin-only preview: this does not create shipping labels, book couriers,
// change order status, charge customers, or debit the Shipbubble wallet.
router.use(protect, authorize("admin"));

router.get("/status", (req, res) => {
  const key = String(process.env.SHIPBUBBLE_LIVE_API_KEY || "");
  res.json({
    success: true, provider: "shipbubble", mode: "live",
    configured: key.startsWith("sb_prod_"),
    bookings_enabled: false, checkout_enabled: false, webhook_enabled: false
  });
});

// Retrieve provider-defined categories rather than hardcoding category IDs.
router.get("/categories", async (req, res) => {
  try {
    const data = await request("/shipping/labels/categories");
    const categories = Array.isArray(data) ? data : [];
    return res.json({
      success: true,
      categories: categories.map(item => ({
        category_id: item.category_id, category: String(item.category || "").slice(0, 120)
      }))
    });
  } catch (error) {
    return res.status(error instanceof ShipbubbleError ? error.httpStatus : 502)
      .json({ success: false, message: error instanceof ShipbubbleError ? error.message : "Unable to load shipping categories." });
  }
});

// Read already-validated addresses from the Shipbubble account.
// Read-only: does not validate new addresses, spend validation credits, or book shipments.
router.get("/addresses", async (req, res) => {
  try {
    const data = await request("/shipping/address");
    const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
    const addresses = results.slice(0, 50).map(normalizeAddressRecord).filter(Boolean);
    return res.json({ success: true, addresses });
  } catch (error) {
    return res.status(error instanceof ShipbubbleError ? error.httpStatus : 502)
      .json({ success: false, message: error instanceof ShipbubbleError ? error.message : "Unable to load validated shipping addresses." });
  }
});

// Explicit admin action: a successful address validation may consume credits.
router.post("/addresses/validate", async (req, res) => {
  const input = normalizeAddressInput(req.body);
  if (!input) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid name, email, phone and full address, and confirm the validation credit charge."
    });
  }
  const adminId = String(req.user.id);
  const now = Date.now();
  const nextAllowed = addressValidationCooldown.get(adminId) || 0;
  if (now < nextAllowed) {
    return res.status(429).json({
      success: false,
      message: "Please wait 60 seconds before validating another address."
    });
  }
  addressValidationCooldown.set(adminId, now + 60000);
  try {
    const data = await request("/shipping/address/validate", {
      method: "POST", body: { name: input.name, email: input.email, phone: input.phone, address: input.address }
    });
    const address = normalizeAddressRecord(data);
    if (!address) {
      return res.status(502).json({
        success: false, message: "Shipbubble did not return a usable address code."
      });
    }
    return res.json({ success: true, address });
  } catch (error) {
    return res.status(error instanceof ShipbubbleError ? error.httpStatus : 502)
      .json({
        success: false,
        message: error instanceof ShipbubbleError ? error.message : "Address validation failed.",
        // Available only to the authenticated administrator who just attempted
        // validation with explicit charge consent. Never includes the raw body.
        support_diagnostic: error instanceof ShipbubbleError ? error.supportDiagnostic || null : null
      });
  }
});

// Requires address codes obtained from Shipbubble's Addresses API.
// Caller supplies only ONE parcel item; this preview cannot be used to book it.
router.post("/preview-rates", async (req, res) => {
  const b = req.body || {};
  const sender = Number(b.sender_address_code);
  const receiver = Number(b.reciever_address_code);
  const category = Number(b.category_id);
  const item = b.package_items?.[0] || {};
  const weight = Number(item.unit_weight);
  const amount = Number(item.unit_amount);
  const quantity = Number(item.quantity);
  const name = String(item.name || "").trim();
  const description = String(item.description || "").trim();
  const dimensions = [b.length, b.width, b.height].map(Number);
  const date = String(b.pickup_date || "").trim();
  const validId = n => Number.isSafeInteger(n) && n > 0;
  if (!validId(sender) || !validId(receiver) || !validId(category) ||
      !Array.isArray(b.package_items) || b.package_items.length !== 1 ||
      !Number.isFinite(weight) || weight <= 0 || weight > 1000 ||
      !Number.isFinite(amount) || amount <= 0 || amount > 100000000 ||
      !validId(quantity) || quantity > 100 ||
      !name || name.length > 120 || !description || description.length > 150 ||
      dimensions.some(n => !Number.isFinite(n) || n <= 0 || n > 1000) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      success: false, message: "Valid Shipbubble address codes, package category, item details, dimensions (cm), and pickup date are required."
    });
  }
  const pickupDate = new Date(date + "T00:00:00Z");
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  if (Number.isNaN(pickupDate.getTime()) || pickupDate.toISOString().slice(0, 10) !== date ||
      pickupDate < today || pickupDate.getTime() > today.getTime() + 7 * 86400000) {
    return res.status(400).json({
      success: false, message: "Shipbubble pickup date must be within the next 7 days."
    });
  }
  try {
    const data = await request("/shipping/fetch_rates", { method: "POST", body: {
      sender_address_code: sender,
      reciever_address_code: receiver, // Shipbubble's API spells this 'reciever'
      pickup_date: date,
      category_id: category,
      package_items: [{
        name, description, unit_weight: String(weight),
        unit_amount: String(amount), quantity: String(quantity)
      }],
      package_dimension: {
        length: dimensions[0], width: dimensions[1], height: dimensions[2]
      }
    } });
    const rates = Array.isArray(data?.couriers) ? data.couriers : [];
    return res.json({
      success: true, provider: "shipbubble", live: true,
      bookings_enabled: false, rates: rates.map(formatRate).filter(Boolean)
    });
  } catch (error) {
    return res.status(error instanceof ShipbubbleError ? error.httpStatus : 502)
      .json({ success: false, message: error instanceof ShipbubbleError ? error.message : "Unable to get shipping quotations." });
  }
});

// Read-only Shipbubble tracking preview. Never create a shipping label or
// expose customer/seller contact details or parcel contents to the UI.
router.get("/shipments", async (req, res) => {
  try {
    const data = await request("/shipping/labels");
    const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
    return res.json({
      success: true, provider: "shipbubble", read_only: true,
      bookings_enabled: false,
      shipments: results.slice(0, 50).map(normalizeShipment).filter(Boolean),
      // This is only the first provider page; do not imply exhaustive history.
      page_limited: true
    });
  } catch (error) {
    return res.status(error instanceof ShipbubbleError ? error.httpStatus : 502)
      .json({ success: false, message: error instanceof ShipbubbleError ? error.message : "Unable to read shipping tracking." });
  }
});

module.exports = router;

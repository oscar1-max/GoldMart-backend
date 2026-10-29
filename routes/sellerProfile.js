"use strict";

const express = require("express");
const pool = require("../db");
const { protect, authorize } = require("../middleware/auth");
const { normalizeSellerProfile } = require("../utils/sellerProfile");

const router = express.Router();
const sellerOnly = [protect, authorize("seller")];

// Private seller settings only: not verification, shipping eligibility,
// public store data, courier booking, or permission to receive payouts.
router.get("/", ...sellerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT business_name, country_code, business_city, business_region, preferred_currency, updated_at FROM seller_profiles WHERE seller_id = $1",
      [req.user.id]
    );
    return res.json({ success: true, profile: result.rows[0] || null });
  } catch (error) {
    console.error("Read seller international profile failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load your seller profile." });
  }
});

router.put("/", ...sellerOnly, async (req, res) => {
  const checked = normalizeSellerProfile(req.body);
  if (!checked.ok) {
    return res.status(400).json({ success: false, message: checked.message });
  }
  const p = checked.profile;
  try {
    const result = await pool.query(
      "INSERT INTO seller_profiles " +
      "(seller_id, business_name, country_code, business_city, business_region, preferred_currency) " +
      "VALUES ($1,$2,$3,$4,$5,$6) " +
      "ON CONFLICT (seller_id) DO UPDATE SET " +
      "business_name = EXCLUDED.business_name, country_code = EXCLUDED.country_code, " +
      "business_city = EXCLUDED.business_city, business_region = EXCLUDED.business_region, " +
      "preferred_currency = EXCLUDED.preferred_currency, updated_at = NOW() " +
      "RETURNING business_name, country_code, business_city, business_region, preferred_currency, updated_at",
      [req.user.id, p.business_name, p.country_code, p.business_city, p.business_region, p.preferred_currency]
    );
    return res.json({
      success: true,
      profile: result.rows[0],
      message: "Seller business profile saved. International delivery and foreign payouts are not enabled."
    });
  } catch (error) {
    console.error("Save seller international profile failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to save your seller profile." });
  }
});

module.exports = router;

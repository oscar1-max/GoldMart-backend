"use strict";

const express = require("express");
const pool = require("../db");
const { protect, authorize } = require("../middleware/auth");
const { normalizePickupAddress } = require("../utils/sellerPickupAddress");

const router = express.Router();
const sellerOnly = [protect, authorize("seller")];

// This is private seller-owned data, not a public store address or a
// Shipbubble-validated location. Do not add it to public product responses.
router.get("/", ...sellerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT contact_name, contact_email, contact_phone, address_line1, address_line2, city, state, country, postal_code, updated_at FROM seller_pickup_addresses WHERE seller_id = $1",
      [req.user.id]
    );
    return res.json({
      success: true,
      address: result.rows[0] || null,
      validation_status: "not_validated"
    });
  } catch (error) {
    console.error("Read seller pickup address failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load your pickup address." });
  }
});

router.put("/", ...sellerOnly, async (req, res) => {
  const checked = normalizePickupAddress(req.body);
  if (!checked.ok) {
    return res.status(400).json({ success: false, message: checked.message });
  }

  const a = checked.address;
  try {
    const result = await pool.query(
      "INSERT INTO seller_pickup_addresses " +
      "(seller_id, contact_name, contact_email, contact_phone, address_line1, address_line2, city, state, country, postal_code) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) " +
      "ON CONFLICT (seller_id) DO UPDATE SET " +
      "contact_name = EXCLUDED.contact_name, contact_email = EXCLUDED.contact_email, " +
      "contact_phone = EXCLUDED.contact_phone, address_line1 = EXCLUDED.address_line1, " +
      "address_line2 = EXCLUDED.address_line2, city = EXCLUDED.city, " +
      "state = EXCLUDED.state, country = EXCLUDED.country, postal_code = EXCLUDED.postal_code, " +
      "updated_at = NOW() " +
      "RETURNING contact_name, contact_email, contact_phone, address_line1, address_line2, city, state, country, postal_code, updated_at",
      [req.user.id, a.contact_name, a.contact_email, a.contact_phone,
        a.address_line1, a.address_line2, a.city, a.state, a.country, a.postal_code]
    );
    return res.json({
      success: true,
      address: result.rows[0],
      validation_status: "not_validated",
      message: "Pickup details saved privately. Courier validation and bookings are not enabled."
    });
  } catch (error) {
    console.error("Save seller pickup address failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to save your pickup address." });
  }
});

module.exports = router;

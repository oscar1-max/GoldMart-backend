"use strict";
const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");
const { assessCartDelivery, loadSellerRoutes } = require("../utils/shippingProviderRegistry");

const router = express.Router();

// Buyer-specific, read-only planning check. No courier calls, wallet charges,
// shipping quotes, live checkout, or private seller pickup details.
router.post("/", protect, async (req, res) => {
  try {
    const destination = req.body?.country;
    if (typeof destination !== "string" || destination.length > 100) {
      return res.status(400).json({ success: false, message: "Enter a valid destination country." });
    }
    const cart = await pool.query(
      "SELECT DISTINCT p.seller_id FROM carts c " +
      "JOIN cart_items ci ON ci.cart_id = c.id " +
      "JOIN products p ON p.id = ci.product_id AND p.is_active = TRUE " +
      "WHERE c.user_id = $1",
      [req.user.id]
    );
    const sellers = await loadSellerRoutes(pool, cart.rows.map(row => row.seller_id));
    return res.json({
      success: true,
      eligibility: assessCartDelivery(sellers, destination)
    });
  } catch (error) {
    console.error("Read buyer delivery eligibility failed:", error.message);
    return res.status(500).json({ success: false, message: "Unable to check delivery preparation." });
  }
});

module.exports = router;

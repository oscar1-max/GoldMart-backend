
const express = require("express");

const authRoutes = require("./auth");
const categoryRoutes = require("./categories");
const productRoutes = require("./products");
const cartRoutes = require("./cart");
const orderRoutes = require("./orders");
const paymentRoutes = require("./payments");
const sellerRoutes = require("./seller");
const reviewRoutes = require("./reviews");
const notificationRoutes = require("./notifications");

// Buyer Protection
const orderProtectionRoutes = require("./orderProtection");

// Admin Refund Management
const adminRefundRoutes = require("./adminRefunds");

// Paystack Refund Processing
const adminRefundProcessingRoutes = require(
  "./adminRefundProcessing"
);

const router = express.Router();

// Existing GoldMart routes
router.use("/auth", authRoutes);
router.use("/categories", categoryRoutes);
router.use("/products", productRoutes);
router.use("/cart", cartRoutes);
router.use("/orders", orderRoutes);
router.use("/payments", paymentRoutes);
router.use("/seller", sellerRoutes);
router.use("/reviews", reviewRoutes);
router.use("/notifications", notificationRoutes);

// Buyer Protection
router.use(
  "/order-protection",
  orderProtectionRoutes
);

// Admin Refund Reviews
router.use(
  "/admin/refunds",
  adminRefundRoutes
);

// Paystack Refund Processing
router.use(
  "/admin/refund-processing",
  adminRefundProcessingRoutes
);

module.exports = router;

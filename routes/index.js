
"use strict";

const express = require("express");

// ========================================
// GOLDMART MARKETPLACE ROUTES
// ========================================

const authRoutes = require("./auth");
const categoryRoutes = require("./categories");
const productRoutes = require("./products");
const cartRoutes = require("./cart");
const orderRoutes = require("./orders");
const paymentRoutes = require("./payments");
const shippingRoutes = require("./shipping");
const sellerRoutes = require("./seller");
const sellerPickupRoutes = require("./sellerPickup");
const sellerProfileRoutes = require("./sellerProfile");
const withdrawalRoutes = require("./withdrawals");
const reviewRoutes = require("./reviews");
const notificationRoutes = require("./notifications");

// ========================================
// BUYER PROTECTION
// ========================================

const orderProtectionRoutes = require(
  "./orderProtection"
);

// ========================================
// ADMIN REFUND MANAGEMENT
// ========================================

const adminRefundRoutes = require(
  "./adminRefunds"
);

// ========================================
// PAYSTACK REFUND PROCESSING
// ========================================

const adminRefundProcessingRoutes = require(
  "./adminRefundProcessing"
);

// ========================================
// CUSTOMER SUPPORT
// ========================================

const supportRoutes = require("./support");

// ========================================
// GOLDMART ADMIN ASSISTANT PRO
// ========================================

// Free rule-based assistant and analytics
const aiAdminRoutes = require("./aiAdmin");

// Existing optional OpenAI-powered chat
// The free assistant does not use this route.
const aiAdminChatRoutes = require(
  "./aiAdminChat"
);

// ========================================
// INTELLIGENT MONITORING
// ========================================

const adminMonitoringRoutes = require(
  "./adminMonitoring"
);

// ========================================
// NEW: FREE ADMIN SUPPORT DRAFTS
// ========================================
//
// Generates response drafts for authorized
// GoldMart administrators.
//
// Does not send messages automatically.
// Does not process payments or refunds.
//
// ========================================

const adminSupportDraftRoutes = require(
  "./adminSupportDrafts"
);

// ========================================
// CREATE MAIN ROUTER
// ========================================

const router = express.Router();

// ========================================
// EXISTING MARKETPLACE ROUTES
// ========================================

router.use("/auth", authRoutes);

router.use("/categories", categoryRoutes);

router.use("/products", productRoutes);

router.use("/cart", cartRoutes);

router.use("/orders", orderRoutes);

router.use("/payments", paymentRoutes);
router.use("/shipping", shippingRoutes);

router.use("/seller", sellerRoutes);
router.use("/seller/pickup-address", sellerPickupRoutes);
router.use("/seller/profile", sellerProfileRoutes);

// Seller withdrawal simulation and admin review: no bank transfers.
router.use("/withdrawals", withdrawalRoutes);

router.use("/reviews", reviewRoutes);

router.use(
  "/notifications",
  notificationRoutes
);

// ========================================
// BUYER PROTECTION
// ========================================

router.use(
  "/order-protection",
  orderProtectionRoutes
);

// ========================================
// ADMIN REFUND MANAGEMENT
// ========================================

router.use(
  "/admin/refunds",
  adminRefundRoutes
);

// ========================================
// PAYSTACK REFUND PROCESSING
// ========================================

router.use(
  "/admin/refund-processing",
  adminRefundProcessingRoutes
);

// ========================================
// CUSTOMER SUPPORT
// ========================================

router.use(
  "/support",
  supportRoutes
);

// ========================================
// INTELLIGENT MONITORING
// ========================================
//
// GET   /api/admin-monitoring/alerts
// POST  /api/admin-monitoring/scan
// PATCH /api/admin-monitoring/alerts/:id/acknowledge
// PATCH /api/admin-monitoring/alerts/:id/resolve
//
// ========================================

router.use(
  "/admin-monitoring",
  adminMonitoringRoutes
);

// ========================================
// NEW: ADMIN SUPPORT DRAFT ASSISTANT
// ========================================
//
// GET  /api/admin-support-drafts
// POST /api/admin-support-drafts/draft
//
// Only authorized administrators can
// access these endpoints.
//
// ========================================

router.use(
  "/admin-support-drafts",
  adminSupportDraftRoutes
);

// ========================================
// OPTIONAL PAID AI CHAT ROUTE
// ========================================
//
// Kept for compatibility.
//
// The existing GoldMart free assistant
// does not call this endpoint.
//
// IMPORTANT:
// Keep this route BEFORE /ai-admin
// because aiAdmin.js includes a
// catch-all 404 handler.
//
// ========================================

router.use(
  "/ai-admin/chat",
  aiAdminChatRoutes
);

// ========================================
// FREE GOLDMART ADMIN ASSISTANT PRO
// ========================================
//
// GET  /api/ai-admin
// GET  /api/ai-admin/overview
// POST /api/ai-admin/free-chat
//
// ========================================

router.use(
  "/ai-admin",
  aiAdminRoutes
);

// ========================================
// EXPORT
// ========================================

module.exports = router;

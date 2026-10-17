
"use strict";

const express = require("express");

// ========================================
// EXISTING GOLDMART ROUTES
// ========================================

const authRoutes = require("./auth");
const categoryRoutes = require("./categories");
const productRoutes = require("./products");
const cartRoutes = require("./cart");
const orderRoutes = require("./orders");
const paymentRoutes = require("./payments");
const sellerRoutes = require("./seller");
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
// GOLDMART AI ADMIN
// ========================================

// Existing read-only monitoring dashboard
const aiAdminRoutes = require("./aiAdmin");

// New OpenAI-powered admin chat
const aiAdminChatRoutes = require(
  "./aiAdminChat"
);

// ========================================
// CREATE ROUTER
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

router.use("/seller", sellerRoutes);

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
// ADMIN REFUND REVIEWS
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
// GOLDMART AI ADMIN CHAT
// ========================================
//
// IMPORTANT:
// Mount the chat route BEFORE the general
// AI Admin route.
//
// The general AI Admin router contains a
// catch-all 404 handler, so reversing these
// two routes would prevent AI Chat from
// being reached.
//
// Authentication and admin-only access
// are enforced inside aiAdminChat.js.
//
// AI Chat is currently READ-ONLY.
// ========================================

router.use(
  "/ai-admin/chat",
  aiAdminChatRoutes
);

// ========================================
// GOLDMART AI ADMIN MONITORING
// ========================================
//
// Existing dashboard and overview.
//
// Authentication and admin-only access
// are enforced inside aiAdmin.js.
// ========================================

router.use(
  "/ai-admin",
  aiAdminRoutes
);

// ========================================
// EXPORT ROUTER
// ========================================

module.exports = router;

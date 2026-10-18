
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
// GOLDMART ADMIN ASSISTANT PRO
// ========================================

// Free rule-based assistant and analytics
const aiAdminRoutes = require("./aiAdmin");

// Existing OpenAI API chat route
// Kept for compatibility.
// Free chat uses /ai-admin/free-chat instead.
const aiAdminChatRoutes = require(
  "./aiAdminChat"
);

// ========================================
// NEW: GOLDMART INTELLIGENT MONITORING
// ========================================
//
// Saves operational alerts.
// Tracks administrator acknowledgement.
// Permits resolving cleared alerts.
//
// Admin-only access is enforced inside
// adminMonitoring.js.
//
// ========================================

const adminMonitoringRoutes = require(
  "./adminMonitoring"
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
// NEW: INTELLIGENT MONITORING
// ========================================
//
// These endpoints manage monitoring
// alert records only.
//
// GET   /api/admin-monitoring/alerts
// POST  /api/admin-monitoring/scan
// PATCH /api/admin-monitoring/alerts/:id/acknowledge
// PATCH /api/admin-monitoring/alerts/:id/resolve
//
// No refunds, payments, orders or
// seller funds are modified.
//
// ========================================

router.use(
  "/admin-monitoring",
  adminMonitoringRoutes
);

// ========================================
// GOLDMART AI ADMIN CHAT
// ========================================
//
// Keep this BEFORE /ai-admin.
//
// The general AI Admin router contains
// a catch-all 404 handler.
//
// The existing paid-model endpoint
// remains registered but is not used
// by the free Pro dashboard.
//
// ========================================

router.use(
  "/ai-admin/chat",
  aiAdminChatRoutes
);

// ========================================
// GOLDMART ADMIN ASSISTANT PRO
// ========================================
//
// GET  /api/ai-admin
// GET  /api/ai-admin/overview
// POST /api/ai-admin/free-chat
//
// Protected administrator routes.
//
// ========================================

router.use(
  "/ai-admin",
  aiAdminRoutes
);

// ========================================
// EXPORT MAIN ROUTER
// ========================================

module.exports = router;

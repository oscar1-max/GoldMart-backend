"use strict";

const crypto = require("crypto");
const express = require("express");
const { protect } = require("../middleware/auth");
const { requireAiAdmin } = require("../middleware/requireAiAdmin");
const {
  getStatus, updateSettings, runAutonomy, enabledOnServer, cronConfigured,
} = require("../services/autonomyWorker");

const router = express.Router();
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

function error(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function secretMatches(provided) {
  if (!cronConfigured() || typeof provided !== "string") return false;
  const expected = Buffer.from(process.env.AUTONOMY_CRON_SECRET, "utf8");
  const actual = Buffer.from(provided, "utf8");
  return actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected);
}

// A scheduled GitHub Actions job can wake a sleeping Render instance.
// This endpoint accepts only the server-side cron secret, not a user token.
router.post("/cron", async (req, res) => {
  if (!enabledOnServer() || !cronConfigured()) {
    return error(res, 503, "Scheduled autonomy is not configured.");
  }
  if (!secretMatches(req.get("x-goldmart-cron-secret"))) {
    return error(res, 401, "Unauthorized scheduled request.");
  }
  try {
    return res.json({ success: true, ...(await runAutonomy("cron")) });
  } catch (err) {
    console.error("GoldMart autonomy scheduled run:", err.message);
    return error(res, 500, "Scheduled review failed.");
  }
});

// All remaining endpoints are limited to configured, authenticated admins.
router.use(protect);
router.use(requireAiAdmin);

router.get("/status", async (_req, res) => {
  try {
    return res.json({ success: true, ...(await getStatus()) });
  } catch (err) {
    console.error("GoldMart autonomy status:", err.message);
    return error(res, 503, "Unable to load AI Admin settings.");
  }
});

router.put("/settings", async (req, res) => {
  const { enabled, mode, seller_reminders_enabled: reminders } = req.body || {};
  if (typeof enabled !== "boolean" ||
      !["supervised", "advanced"].includes(mode) ||
      typeof reminders !== "boolean") {
    return error(res, 400, "Invalid autonomy settings.");
  }
  // Disallow advanced-only permissions in supervised mode.
  if (mode === "supervised" && reminders) {
    return error(res, 400, "Seller reminders require advanced mode.");
  }
  if (enabled && !enabledOnServer()) {
    return error(res, 503, "Server autonomy must be enabled first.");
  }
  try {
    const settings = await updateSettings(
      { enabled, mode, seller_reminders_enabled: reminders },
      req.aiAdmin.userId
    );
    return res.json({ success: true, settings });
  } catch (err) {
    console.error("GoldMart autonomy settings:", err.message);
    return error(res, 503, "Unable to save AI Admin settings.");
  }
});

router.post("/run", async (_req, res) => {
  try {
    return res.json({ success: true, ...(await runAutonomy("manual")) });
  } catch (err) {
    console.error("GoldMart autonomy manual run:", err.message);
    return error(res, 503, "Unable to run AI Admin review.");
  }
});

module.exports = router;

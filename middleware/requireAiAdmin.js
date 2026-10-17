
"use strict";

// =====================================================
// GOLDMART AI ADMIN — STRICT ACCESS CONTROL
// =====================================================
//
// This middleware must run AFTER protect.
//
// It never trusts an admin ID supplied in a request,
// user message, query parameter, or AI instruction.
//
// Only authenticated accounts whose database user ID
// matches ADMIN_USER_ID can access AI Admin.
//
// No refunds, payouts, account bans, or financial
// actions are performed here.
// =====================================================

function getConfiguredAdminIds() {
  const raw = String(
    process.env.ADMIN_USER_ID || ""
  ).trim();

  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[1-9]\d*$/.test(value))
    .map((value) => Number(value))
    .filter(
      (value) =>
        Number.isSafeInteger(value) &&
        value > 0
    );
}

function requireAiAdmin(req, res, next) {
  try {
    // The existing protect middleware should have
    // already authenticated the user against Neon.

    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const userId = Number(req.user.id);

    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0
    ) {
      return res.status(403).json({
        success: false,
        message: "Access denied.",
      });
    }

    // Never grant access when the configuration
    // is missing or incorrectly configured.

    const adminIds = getConfiguredAdminIds();

    if (
      adminIds.length === 0 ||
      !adminIds.includes(userId)
    ) {
      console.warn(
        "GoldMart AI Admin access denied:",
        "unauthorized account"
      );

      return res.status(403).json({
        success: false,
        message:
          "This feature is restricted to authorized GoldMart administrators.",
      });
    }

    // Even an admin account flagged as banned
    // should not be allowed to operate the AI
    // until that account status is reviewed.

    if (req.user.is_banned === true) {
      return res.status(403).json({
        success: false,
        message:
          "Administrator account requires security review.",
      });
    }

    // Record that this request passed the
    // independent AI Admin authorization check.

    req.aiAdmin = {
      userId,
      permissions: {
        viewReports: true,
        reviewAlerts: true,
        analyzeOrders: true,
        draftResponses: true,

        // Sensitive operations are prohibited.
        approveRefunds: false,
        initiatePayments: false,
        transferSellerFunds: false,
        banAccounts: false,
        modifyPaymentSettings: false,
      },
    };

    return next();
  } catch (error) {
    console.error(
      "GoldMart AI Admin authorization error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "AI Admin security verification failed.",
    });
  }
}

module.exports = {
  requireAiAdmin,
};

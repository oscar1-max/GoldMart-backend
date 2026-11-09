"use strict";

// Pure eligibility gate. This module does not update orders or initiate payouts.
// Only independently verified carrier evidence may start the 48-hour clock.
// Seller-reported statuses, tracking numbers, and estimated dates are not evidence.
const CONFIRMATION_WAIT_MS = 48 * 60 * 60 * 1000;
const SELLER_PROTECTION_MS = 7 * 24 * 60 * 60 * 1000;

function evaluateAutomaticDeliveryConfirmation(input, now = new Date()) {
  const pending = (reason) => ({ eligible: false, reason });
  if (!input || input.orderStatus !== "delivered") return pending("Order is not delivered.");
  if (input.paymentStatus !== "success") return pending("Payment is not verified.");
  if (input.hasRefundOrDispute) return pending("Refund or dispute requires review.");
  if (input.buyerReportedNotReceived) return pending("Buyer reports item not received.");
  if (input.buyerConfirmedAt) return pending("Buyer has already confirmed delivery.");
  if (input.proofSource !== "verified_courier" || input.proofVerified !== true) {
    return pending("Independent courier proof of delivery is required.");
  }
  const deliveredAt = new Date(input.verifiedDeliveredAt).getTime();
  const currentTime = new Date(now).getTime();
  if (!Number.isFinite(deliveredAt) || !Number.isFinite(currentTime) || deliveredAt > currentTime) {
    return pending("Verified delivery timestamp is invalid.");
  }
  if (currentTime - deliveredAt < CONFIRMATION_WAIT_MS) {
    return pending("48-hour buyer response period is still open.");
  }
  return {
    eligible: true,
    reason: "Verified courier delivery and 48-hour response period completed without a reported issue.",
    verifiedDeliveredAt: new Date(deliveredAt).toISOString(),
    sellerProtectionEndsAt: new Date(deliveredAt + SELLER_PROTECTION_MS).toISOString(),
  };
}

module.exports = {
  evaluateAutomaticDeliveryConfirmation,
  CONFIRMATION_WAIT_MS,
  SELLER_PROTECTION_MS,
};

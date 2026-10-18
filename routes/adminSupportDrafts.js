
"use strict";

// =====================================================
// GOLDMART ADMIN SUPPORT ASSISTANT
// FREE EDITION
// =====================================================
//
// Prepares customer support drafts for admin review.
//
// - No paid AI API
// - Admin-only
// - No customer messages sent automatically
// - No refund or payment processing
// - No account changes
// - No database writes
//
// =====================================================

const express = require("express");

const { protect } = require("../middleware/auth");

const {
  requireAiAdmin,
} = require("../middleware/requireAiAdmin");

const router = express.Router();

router.use(protect);
router.use(requireAiAdmin);

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// =====================================================
// SUPPORTED ISSUES
// =====================================================

const ISSUES = [
  {
    id: "delivery_delay",
    name: "Delayed delivery",
  },
  {
    id: "refund_request",
    name: "Refund request",
  },
  {
    id: "damaged_item",
    name: "Damaged product",
  },
  {
    id: "missing_item",
    name: "Missing product",
  },
  {
    id: "payment_status",
    name: "Payment status concern",
  },
  {
    id: "seller_fulfillment",
    name: "Seller fulfillment problem",
  },
  {
    id: "general",
    name: "General support question",
  },
];

// =====================================================
// RESPONSE TEMPLATES
// =====================================================
//
// These templates do not assume that a complaint
// has been verified.
//
// They never guarantee refunds, deliveries,
// payouts or other financial outcomes.
//
// =====================================================

const TEMPLATES = {
  delivery_delay: {
    buyer: {
      draft:
        "Hello,\n\n" +
        "Thank you for contacting GoldMart about " +
        "your delivery. We understand your concern " +
        "and will review the available order and " +
        "shipping information.\n\n" +
        "Our support team will check the recorded " +
        "status and provide an update when the " +
        "relevant information has been verified.\n\n" +
        "Thank you for your patience.\n\n" +
        "GoldMart Support",

      checks: [
        "Confirm the correct order record.",
        "Review shipment and delivery evidence.",
        "Check the seller's fulfillment status.",
        "Provide only verified delivery updates.",
      ],
    },

    seller: {
      draft:
        "Hello,\n\n" +
        "GoldMart is reviewing a fulfillment delay " +
        "and needs an update on the relevant order.\n\n" +
        "Please check the order record and provide " +
        "the current shipping status and any " +
        "available supporting evidence.\n\n" +
        "Thank you for your cooperation.\n\n" +
        "GoldMart Support",

      checks: [
        "Verify the seller and relevant order.",
        "Request available shipment evidence.",
        "Check whether the order is overdue.",
        "Review the response before updating the buyer.",
      ],
    },
  },

  refund_request: {
    buyer: {
      draft:
        "Hello,\n\n" +
        "Thank you for contacting GoldMart about " +
        "your refund request.\n\n" +
        "We will review the request, available " +
        "order details, and supporting evidence " +
        "before making a decision under the " +
        "applicable policies and consumer rights.\n\n" +
        "Submitting a request does not mean that " +
        "a refund has already been approved or " +
        "processed. We will provide an update " +
        "when the review is complete.\n\n" +
        "GoldMart Support",

      checks: [
        "Verify the refund request and order.",
        "Review buyer and seller evidence fairly.",
        "Check applicable policies and legal rights.",
        "Do not promise or process a refund automatically.",
      ],
    },

    seller: {
      draft:
        "Hello,\n\n" +
        "GoldMart is reviewing a refund request " +
        "connected to an order requiring attention.\n\n" +
        "Please provide relevant fulfillment " +
        "information and any available supporting " +
        "evidence for an impartial review.\n\n" +
        "No final decision is implied by this " +
        "request for information.\n\n" +
        "GoldMart Support",

      checks: [
        "Confirm the order and refund request.",
        "Review the seller's evidence.",
        "Review the buyer's evidence.",
        "Escalate the decision to an authorized reviewer.",
      ],
    },
  },

  damaged_item: {
    buyer: {
      draft:
        "Hello,\n\n" +
        "We're sorry to hear about the condition " +
        "of the product you received.\n\n" +
        "GoldMart will review the order and the " +
        "information available about the reported " +
        "damage. If additional photographs or " +
        "details are needed, our support team " +
        "will explain what to provide.\n\n" +
        "Your concern will be reviewed before " +
        "any resolution is confirmed.\n\n" +
        "GoldMart Support",

      checks: [
        "Verify the order and product.",
        "Review relevant photographs or evidence.",
        "Check the seller's response.",
        "Consider applicable consumer rights.",
      ],
    },

    seller: {
      draft:
        "Hello,\n\n" +
        "A product condition concern has been " +
        "reported to GoldMart.\n\n" +
        "Please review the relevant order and " +
        "provide available product, packaging, " +
        "and fulfillment information.\n\n" +
        "GoldMart will consider the available " +
        "evidence before reaching a decision.\n\n" +
        "GoldMart Support",

      checks: [
        "Verify the product and order.",
        "Request relevant condition evidence.",
        "Review both parties' information.",
        "Do not assume responsibility before review.",
      ],
    },
  },

  missing_item: {
    buyer: {
      draft:
        "Hello,\n\n" +
        "Thank you for reporting a missing item.\n\n" +
        "We will review the relevant order, " +
        "the items recorded as purchased, and " +
        "available fulfillment information.\n\n" +
        "Our team may request additional details " +
        "to complete the review. We will explain " +
        "the next steps after checking the " +
        "available evidence.\n\n" +
        "GoldMart Support",

      checks: [
        "Verify the order contents.",
        "Review packing and delivery records.",
        "Check any available seller evidence.",
        "Determine appropriate next steps fairly.",
      ],
    },

    seller: {
      draft:
        "Hello,\n\n" +
        "GoldMart is reviewing a report that an " +
        "item may be missing from an order.\n\n" +
        "Please check the order contents, " +
        "packing information, and available " +
        "shipping records.\n\n" +
        "Your response will help the support " +
        "team complete its review.\n\n" +
        "GoldMart Support",

      checks: [
        "Confirm the order contents.",
        "Review packing records.",
        "Check fulfillment evidence.",
        "Compare the evidence before deciding.",
      ],
    },
  },

  payment_status: {
    buyer: {
      draft:
        "Hello,\n\n" +
        "Thank you for contacting GoldMart about " +
        "your payment status.\n\n" +
        "We will review the available order " +
        "and payment records before confirming " +
        "whether a payment was verified.\n\n" +
        "Please do not share your PIN, password, " +
        "or full card details with anyone.\n\n" +
        "GoldMart Support",

      checks: [
        "Locate the relevant order.",
        "Check verified payment-provider evidence.",
        "Do not rely only on screenshots or claims.",
        "Never request passwords, PINs or full card details.",
      ],
    },

    seller: {
      draft:
        "Hello,\n\n" +
        "Thank you for contacting GoldMart about " +
        "an order's payment status.\n\n" +
        "The support team will review the " +
        "available records before confirming " +
        "any verified payment information.\n\n" +
        "A database status alone does not prove " +
        "that seller funds have been transferred.\n\n" +
        "GoldMart Support",

      checks: [
        "Verify the relevant order.",
        "Review trusted payment status records.",
        "Do not promise a seller payout.",
        "Escalate financial questions for authorized review.",
      ],
    },
  },

  seller_fulfillment: {
    buyer: {
      draft:
        "Hello,\n\n" +
        "GoldMart will review your concern " +
        "about the handling of your order.\n\n" +
        "We will check the recorded fulfillment " +
        "information and seek clarification " +
        "where necessary.\n\n" +
        "We will share verified next steps " +
        "once the review has progressed.\n\n" +
        "GoldMart Support",

      checks: [
        "Verify the order.",
        "Check the fulfillment timeline.",
        "Review available seller evidence.",
        "Escalate unresolved issues for human review.",
      ],
    },

    seller: {
      draft:
        "Hello,\n\n" +
        "GoldMart is following up about an " +
        "order that requires a fulfillment update.\n\n" +
        "Please review the relevant order and " +
        "provide its current status, along with " +
        "supporting shipment information where " +
        "available.\n\n" +
        "Thank you for helping us keep order " +
        "information accurate.\n\n" +
        "GoldMart Support",

      checks: [
        "Verify the seller account and order.",
        "Review the current order status.",
        "Request any necessary fulfillment evidence.",
        "Avoid making unsupported allegations.",
      ],
    },
  },

  general: {
    buyer: {
      draft:
        "Hello,\n\n" +
        "Thank you for contacting GoldMart Support.\n\n" +
        "We have received your concern and will " +
        "review the relevant information before " +
        "providing a specific response.\n\n" +
        "If more details are required, our " +
        "support team will let you know.\n\n" +
        "GoldMart Support",

      checks: [
        "Identify the buyer's actual concern.",
        "Verify any referenced order.",
        "Check the available evidence.",
        "Customize the draft before sending.",
      ],
    },

    seller: {
      draft:
        "Hello,\n\n" +
        "Thank you for contacting GoldMart Support.\n\n" +
        "We will review the relevant information " +
        "and follow up with any questions " +
        "needed to understand the issue.\n\n" +
        "GoldMart Support",

      checks: [
        "Identify the seller's actual concern.",
        "Verify any referenced order or product.",
        "Check the available evidence.",
        "Customize the draft before sending.",
      ],
    },
  },
};

// =====================================================
// GET /api/admin-support-drafts
// LIST SUPPORTED CATEGORIES
// =====================================================

router.get("/", (req, res) => {
  return res.json({
    success: true,

    service:
      "GoldMart Free Support Draft Assistant",

    mode: "rule_based_draft_only",

    issues: ISSUES,

    audiences: [
      "buyer",
      "seller",
    ],

    permissions: {
      prepare_drafts: true,
      send_messages: false,
      approve_refunds: false,
      process_payments: false,
      ban_users: false,
    },
  });
});

// =====================================================
// POST /api/admin-support-drafts/draft
// GENERATE A SUPPORT DRAFT
// =====================================================
//
// Example request:
//
// {
//   "audience": "buyer",
//   "issue": "delivery_delay"
// }
//
// No customer information is required.
//
// =====================================================

router.post("/draft", (req, res) => {
  try {
    const audience =
      typeof req.body?.audience === "string"
        ? req.body.audience.trim()
        : "";

    const issue =
      typeof req.body?.issue === "string"
        ? req.body.issue.trim()
        : "";

    if (
      audience !== "buyer" &&
      audience !== "seller"
    ) {
      return res.status(400).json({
        success: false,

        message:
          "Select either buyer or seller.",
      });
    }

    if (
      !Object.prototype.hasOwnProperty.call(
        TEMPLATES,
        issue
      )
    ) {
      return res.status(400).json({
        success: false,

        message:
          "Choose a supported support issue.",
      });
    }

    const selected =
      TEMPLATES[issue][audience];

    const issueInfo =
      ISSUES.find(
        (item) => item.id === issue
      );

    return res.json({
      success: true,

      service:
        "GoldMart Free Support Draft Assistant",

      audience,

      issue,

      issue_name:
        issueInfo?.name || issue,

      draft: selected.draft,

      review_checklist:
        selected.checks,

      requires_human_review: true,

      automatically_sent: false,

      financial_actions_enabled: false,

      note:
        "This is a reusable draft, not an " +
        "investigation result. Review the " +
        "actual case and customize the " +
        "message before sending.",
    });
  } catch (error) {
    console.error(
      "Support draft error:",
      error.message
    );

    return res.status(500).json({
      success: false,

      message:
        "Unable to prepare support draft.",
    });
  }
});

module.exports = router;

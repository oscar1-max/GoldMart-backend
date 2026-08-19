const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const FRONTEND_URL =
  process.env.FRONTEND_URL || "http://localhost:3000";

// =====================================================
// CHECK PAYSTACK CONFIGURATION
// =====================================================

router.get("/config", protect, (req, res) => {
  res.json({
    success: true,
    configured: Boolean(PAYSTACK_SECRET_KEY),
  });
});

// =====================================================
// INITIALIZE PAYMENT
// =====================================================

router.post("/initialize", protect, async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: "Payment provider is not configured.",
      });
    }

    const {
      email,
      amount,
      currency = "NGN",
      metadata = {},
    } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required.",
      });
    }

    const numericAmount = Number(amount);

    if (
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid payment amount is required.",
      });
    }

    const normalizedCurrency =
      String(currency).toUpperCase();

    const allowedCurrencies = [
      "NGN",
      "GHS",
      "ZAR",
      "KES",
      "USD",
    ];

    if (
      !allowedCurrencies.includes(
        normalizedCurrency
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Unsupported payment currency.",
      });
    }

    /*
      Paystack expects the amount in the smallest
      currency unit.

      Example:
      ₦2,500 -> 250000 kobo
      $10    -> 1000 cents
    */

    const amountInSubunit = Math.round(
      numericAmount * 100
    );

    const reference = `GM-${Date.now()}-${crypto
      .randomBytes(5)
      .toString("hex")
      .toUpperCase()}`;

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          amount: amountInSubunit,
          currency: normalizedCurrency,
          reference,
          callback_url: `${FRONTEND_URL}/checkout`,
          metadata: {
            user_id: req.user.id,
            ...metadata,
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      console.error(
        "Paystack initialization failed:",
        data
      );

      return res.status(400).json({
        success: false,
        message:
          data.message ||
          "Unable to initialize payment.",
      });
    }

    await pool.query(
      `
      INSERT INTO payments (
        user_id,
        reference,
        amount,
        currency,
        status,
        payment_method
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        req.user.id,
        reference,
        numericAmount,
        normalizedCurrency,
        "pending",
        "paystack",
      ]
    );

    res.json({
      success: true,
      message: "Payment initialized successfully.",
      payment: {
        reference,
        authorization_url:
          data.data.authorization_url,
        access_code: data.data.access_code,
        amount: numericAmount,
        currency: normalizedCurrency,
        status: "pending",
      },
    });
  } catch (error) {
    console.error(
      "Payment initialization error:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Failed to initialize payment.",
    });
  }
});

// =====================================================
// VERIFY PAYMENT
// =====================================================

router.get(
  "/verify/:reference",
  protect,
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return res.status(500).json({
          success: false,
          message:
            "Payment provider is not configured.",
        });
      }

      const { reference } = req.params;

      if (!reference) {
        return res.status(400).json({
          success: false,
          message:
            "Payment reference is required.",
        });
      }

      const paymentResult = await pool.query(
        `
        SELECT *
        FROM payments
        WHERE reference = $1
          AND user_id = $2
        LIMIT 1
        `,
        [reference, req.user.id]
      );

      if (
        paymentResult.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Payment record not found.",
        });
      }

      const payment =
        paymentResult.rows[0];

      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(
          reference
        )}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          },
        }
      );

      const data = await response.json();

      if (!response.ok || !data.status) {
        console.error(
          "Paystack verification failed:",
          data
        );

        return res.status(400).json({
          success: false,
          message:
            data.message ||
            "Unable to verify payment.",
        });
      }

      const transaction =
        data.data;

      const verifiedAmount =
        Number(transaction.amount) /
        100;

      const verifiedCurrency =
        String(
          transaction.currency || ""
        ).toUpperCase();

      const expectedAmount =
        Number(payment.amount);

      const expectedCurrency =
        String(
          payment.currency
        ).toUpperCase();

      /*
        IMPORTANT:
        Never trust the frontend when deciding
        whether a payment succeeded.

        We compare the provider's returned
        amount and currency against our own
        database record.
      */

      if (
        verifiedAmount !==
          expectedAmount ||
        verifiedCurrency !==
          expectedCurrency
      ) {
        await pool.query(
          `
          UPDATE payments
          SET
            status = $1,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
          `,
          [
            "amount_mismatch",
            payment.id,
          ]
        );

        return res.status(400).json({
          success: false,
          message:
            "Payment amount or currency mismatch.",
        });
      }

      const paymentStatus =
        transaction.status ===
        "success"
          ? "success"
          : "failed";

      await pool.query(
        `
        UPDATE payments
        SET
          status = $1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        `,
        [
          paymentStatus,
          payment.id,
        ]
      );

      res.json({
        success:
          paymentStatus ===
          "success",
        message:
          paymentStatus ===
          "success"
            ? "Payment verified successfully."
            : "Payment was not successful.",
        payment: {
          reference,
          status:
            paymentStatus,
          amount:
            verifiedAmount,
          currency:
            verifiedCurrency,
          gateway_response:
            transaction.gateway_response,
          paid_at:
            transaction.paid_at,
          channel:
            transaction.channel,
        },
      });
    } catch (error) {
      console.error(
        "Payment verification error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to verify payment.",
      });
    }
  }
);

// =====================================================
// GET PAYMENT
// =====================================================

router.get(
  "/:reference",
  protect,
  async (req, res) => {
    try {
      const { reference } =
        req.params;

      const result =
        await pool.query(
          `
          SELECT
            id,
            order_id,
            user_id,
            reference,
            amount,
            currency,
            status,
            payment_method,
            created_at,
            updated_at
          FROM payments
          WHERE reference = $1
            AND user_id = $2
          LIMIT 1
          `,
          [
            reference,
            req.user.id,
          ]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Payment not found.",
        });
      }

      res.json({
        success: true,
        payment:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Get payment error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to fetch payment.",
      });
    }
  }
);

module.exports = router;

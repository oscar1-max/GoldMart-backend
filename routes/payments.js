const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY;

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "http://localhost:3000";

const USD_TO_NGN_RATE =
  Number(process.env.USD_TO_NGN_RATE) || 1500;

function normalizeCurrency(currency) {
  return String(currency || "USD").toUpperCase();
}

// =====================================================
// PAYSTACK CONFIG
// =====================================================

router.get("/config", protect, (req, res) => {
  return res.json({
    success: true,
    configured: Boolean(PAYSTACK_SECRET_KEY),
    currency: "NGN",
    usd_to_ngn_rate: USD_TO_NGN_RATE,
  });
});

// =====================================================
// INITIALIZE PAYMENT
// =====================================================

router.post(
  "/initialize",
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

      const {
        email,
        amount,
        currency = "USD",
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
          message:
            "A valid payment amount is required.",
        });
      }

      const requestedCurrency =
        normalizeCurrency(currency);

      let amountUSD;
      let amountNGN;

      if (requestedCurrency === "USD") {
        amountUSD = numericAmount;

        amountNGN = Math.round(
          amountUSD * USD_TO_NGN_RATE
        );
      } else if (requestedCurrency === "NGN") {
        amountNGN = numericAmount;

        amountUSD =
          amountNGN / USD_TO_NGN_RATE;
      } else {
        return res.status(400).json({
          success: false,
          message:
            "GoldMart currently supports USD and NGN checkout.",
        });
      }

      if (
        !Number.isFinite(amountNGN) ||
        amountNGN <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Unable to calculate NGN payment amount.",
        });
      }

      const amountInKobo =
        Math.round(amountNGN * 100);

      const reference =
        `GM-${Date.now()}-${crypto
          .randomBytes(5)
          .toString("hex")
          .toUpperCase()}`;

      const response = await fetch(
        "https://api.paystack.co/transaction/initialize",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${PAYSTACK_SECRET_KEY}`,

            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            email,

            amount: amountInKobo,

            currency: "NGN",

            reference,

            callback_url:
              `${FRONTEND_URL}/order-success`,

            metadata: {
              user_id: req.user.id,

              goldmart_currency:
                requestedCurrency,

              goldmart_amount_usd:
                Number(
                  amountUSD.toFixed(2)
                ),

              goldmart_amount_ngn:
                amountNGN,

              usd_to_ngn_rate:
                USD_TO_NGN_RATE,

              ...metadata,
            },
          }),
        }
      );

      const data = await response.json();

      if (
        !response.ok ||
        !data.status ||
        !data.data
      ) {
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
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6
        )
        `,
        [
          req.user.id,
          reference,
          amountNGN,
          "NGN",
          "pending",
          metadata.payment_method ||
            "paystack",
        ]
      );

      return res.json({
        success: true,

        message:
          "Payment initialized successfully.",

        payment: {
          reference,

          authorization_url:
            data.data.authorization_url,

          access_code:
            data.data.access_code,

          amount_usd:
            Number(
              amountUSD.toFixed(2)
            ),

          amount_ngn:
            amountNGN,

          currency: "NGN",

          exchange_rate:
            USD_TO_NGN_RATE,

          status: "pending",
        },
      });
    } catch (error) {
      console.error(
        "Payment initialization error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to initialize payment.",
      });
    }
  }
);

// =====================================================
// VERIFY PAYMENT
// =====================================================

router.get(
  "/verify/:reference",
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return res.status(500).json({
          success: false,
          message:
            "Payment provider is not configured.",
        });
      }

      const reference =
        String(
          req.params.reference || ""
        ).trim();

      if (!reference) {
        return res.status(400).json({
          success: false,
          message:
            "Payment reference is required.",
        });
      }

      // -------------------------------------------------
      // FIND GOLDMART PAYMENT
      // -------------------------------------------------

      const paymentResult =
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
          LIMIT 1
          `,
          [reference]
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

      // -------------------------------------------------
      // ALREADY VERIFIED
      // -------------------------------------------------

      if (payment.status === "success") {
        return res.json({
          success: true,

          message:
            "Payment already verified.",

          payment: {
            id: payment.id,

            user_id:
              payment.user_id,

            order_id:
              payment.order_id,

            reference:
              payment.reference,

            status: "success",

            amount_ngn:
              Number(payment.amount),

            currency:
              normalizeCurrency(
                payment.currency
              ),

            amount_usd:
              Number(
                (
                  Number(payment.amount) /
                  USD_TO_NGN_RATE
                ).toFixed(2)
              ),

            exchange_rate:
              USD_TO_NGN_RATE,
          },
        });
      }

      // -------------------------------------------------
      // ASK PAYSTACK
      // -------------------------------------------------

      const response =
        await fetch(
          `https://api.paystack.co/transaction/verify/${encodeURIComponent(
            reference
          )}`,
          {
            method: "GET",

            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET_KEY}`,

              Accept:
                "application/json",
            },
          }
        );

      const data =
        await response.json();

      if (
        !response.ok ||
        !data.status
      ) {
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

      if (!transaction) {
        return res.status(400).json({
          success: false,
          message:
            "Paystack returned no transaction data.",
        });
      }

      // -------------------------------------------------
      // VERIFY REFERENCE
      // -------------------------------------------------

      if (
        String(
          transaction.reference
        ) !== reference
      ) {
        await pool.query(
          `
          UPDATE payments
          SET
            status = 'reference_mismatch',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          `,
          [payment.id]
        );

        return res.status(400).json({
          success: false,
          message:
            "Payment reference mismatch.",
        });
      }

      // -------------------------------------------------
      // VERIFY CURRENCY
      // -------------------------------------------------

      const verifiedCurrency =
        normalizeCurrency(
          transaction.currency
        );

      if (
        verifiedCurrency !== "NGN"
      ) {
        await pool.query(
          `
          UPDATE payments
          SET
            status = 'currency_mismatch',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          `,
          [payment.id]
        );

        return res.status(400).json({
          success: false,
          message:
            "Payment currency mismatch.",
        });
      }

      // -------------------------------------------------
      // VERIFY AMOUNT
      // -------------------------------------------------

      const verifiedAmountNGN =
        Number(transaction.amount) / 100;

      const expectedAmountNGN =
        Number(payment.amount);

      if (
        !Number.isFinite(
          verifiedAmountNGN
        ) ||
        Math.abs(
          verifiedAmountNGN -
            expectedAmountNGN
        ) > 0.01
      ) {
        await pool.query(
          `
          UPDATE payments
          SET
            status = 'amount_mismatch',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          `,
          [payment.id]
        );

        return res.status(400).json({
          success: false,

          message:
            "Payment amount does not match the expected amount.",

          details: {
            expected_ngn:
              expectedAmountNGN,

            received_ngn:
              verifiedAmountNGN,
          },
        });
      }

      // -------------------------------------------------
      // VERIFY STATUS
      // -------------------------------------------------

      const paymentStatus =
        String(
          transaction.status || ""
        ).toLowerCase() === "success"
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

      if (
        paymentStatus !== "success"
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Payment was not successful.",

          payment: {
            reference,

            status:
              paymentStatus,

            amount_ngn:
              verifiedAmountNGN,

            currency:
              verifiedCurrency,
          },
        });
      }

      // -------------------------------------------------
      // SUCCESS
      // -------------------------------------------------

      return res.json({
        success: true,

        message:
          "Payment verified successfully.",

        payment: {
          id: payment.id,

          user_id:
            payment.user_id,

          order_id:
            payment.order_id,

          reference,

          status: "success",

          amount_ngn:
            verifiedAmountNGN,

          currency:
            verifiedCurrency,

          amount_usd:
            Number(
              (
                verifiedAmountNGN /
                USD_TO_NGN_RATE
              ).toFixed(2)
            ),

          exchange_rate:
            USD_TO_NGN_RATE,

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

      return res.status(500).json({
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
      const reference =
        String(
          req.params.reference || ""
        ).trim();

      if (!reference) {
        return res.status(400).json({
          success: false,
          message:
            "Payment reference is required.",
        });
      }

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

      return res.json({
        success: true,
        payment:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Get payment error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to fetch payment.",
      });
    }
  }
);

module.exports = router;

const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

const FRONTEND_URL = (
  process.env.FRONTEND_URL || "http://localhost:3000"
).replace(/\/$/, "");

const USD_TO_NGN_RATE = Number(
  process.env.USD_TO_NGN_RATE || 1500
);

// =====================================================
// MONEY HELPERS
// =====================================================

function toMinor(value) {
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      !Number.isSafeInteger(Math.round(value * 100))
    ) {
      throw new Error("Invalid monetary amount in cart.");
    }

    return Math.round(value * 100);
  }

  const s = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);

  if (!match) {
    throw new Error("Invalid monetary amount in cart.");
  }

  const minor =
    Number(match[1]) * 100 +
    Number((match[2] || "").padEnd(2, "0"));

  if (!Number.isSafeInteger(minor)) {
    throw new Error("Monetary amount is too large.");
  }

  return minor;
}

function currencyOf(value) {
  return String(value || "USD").trim().toUpperCase();
}

// =====================================================
// PAYSTACK REQUEST HELPER
// =====================================================

async function fetchPaystack(path, options) {
  const response = await fetch(
    `https://api.paystack.co${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        Accept: "application/json",
        ...(options && options.headers
          ? options.headers
          : {}),
      },
    }
  );

  const data = await response.json();

  if (
    !response.ok ||
    !data.status ||
    !data.data
  ) {
    const error = new Error(
      data.message || "Payment provider is unavailable."
    );

    error.httpStatus = 502;

    throw error;
  }

  return data.data;
}

// =====================================================
// PAYMENT CONFIGURATION
// =====================================================

router.get("/config", protect, (req, res) => {
  res.json({
    success: true,
    configured: Boolean(PAYSTACK_SECRET_KEY),
    currency: "NGN",
    usd_to_ngn_rate: USD_TO_NGN_RATE,
  });
});

// =====================================================
// INITIALIZE PAYMENT
// =====================================================

router.post("/initialize", protect, async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        success: false,
        message: "Payment provider is not configured.",
      });
    }

    if (
      !Number.isFinite(USD_TO_NGN_RATE) ||
      USD_TO_NGN_RATE <= 0
    ) {
      return res.status(503).json({
        success: false,
        message: "Checkout conversion rate is not configured.",
      });
    }

    const email = String(
      req.body?.email || ""
    ).trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        message: "A valid email is required.",
      });
    }

    // Read actual cart prices directly from Neon.
    const result = await pool.query(
      `
      SELECT
        p.id AS product_id,
        p.name,
        p.price,
        p.currency,
        p.stock,
        p.seller_id,
        ci.quantity
      FROM carts c
      JOIN cart_items ci
        ON ci.cart_id = c.id
      JOIN products p
        ON p.id = ci.product_id
      WHERE c.user_id = $1
      ORDER BY p.id
      `,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Your cart is empty.",
      });
    }

    // =================================================
    // CHECK CURRENCIES
    // =================================================

    const currencies = [
      ...new Set(
        result.rows.map((item) =>
          currencyOf(item.currency)
        )
      ),
    ];

    if (
      currencies.length !== 1 ||
      !["USD", "NGN"].includes(currencies[0])
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Checkout requires one supported currency: USD or NGN.",
      });
    }

    const orderCurrency = currencies[0];

    let orderTotalMinor = 0;

    const items = [];

    // =================================================
    // CALCULATE TOTAL FROM DATABASE
    // =================================================

    for (const row of result.rows) {
      const quantity = Number(row.quantity);

      if (
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        quantity > Number(row.stock)
      ) {
        return res.status(409).json({
          success: false,
          message:
            `${row.name} is out of stock or has an invalid quantity. Update your cart.`,
        });
      }

      const unitPriceMinor = toMinor(row.price);

      if (unitPriceMinor <= 0) {
        return res.status(409).json({
          success: false,
          message:
            `The price for ${row.name} needs correction before checkout.`,
        });
      }

      orderTotalMinor += unitPriceMinor * quantity;

      if (!Number.isSafeInteger(orderTotalMinor)) {
        return res.status(400).json({
          success: false,
          message:
            "Cart total exceeds the supported limit.",
        });
      }

      items.push({
        product_id: Number(row.product_id),
        name: String(row.name),
        seller_id:
          row.seller_id == null
            ? null
            : Number(row.seller_id),
        quantity,
        unit_price_minor: unitPriceMinor,
      });
    }

    // =================================================
    // COMPARE FRONTEND WITH DATABASE
    // =================================================

    const submittedCurrency = currencyOf(
      req.body?.currency || orderCurrency
    );

    const submittedAmount = req.body?.amount;

    if (
      submittedCurrency !== orderCurrency ||
      (
        submittedAmount != null &&
        toMinor(submittedAmount) !== orderTotalMinor
      )
    ) {
      return res.status(409).json({
        success: false,
        message:
          "Your cart prices have changed. Refresh the checkout page before paying.",
      });
    }

    // =================================================
    // CONVERT TO PAYSTACK KOBO
    // =================================================

    const expectedKobo =
      orderCurrency === "USD"
        ? Math.round(
            orderTotalMinor * USD_TO_NGN_RATE
          )
        : orderTotalMinor;

    if (
      !Number.isSafeInteger(expectedKobo) ||
      expectedKobo <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Payment amount cannot be calculated safely.",
      });
    }

    // =================================================
    // GENERATE UNIQUE PAYMENT REFERENCE
    // =================================================

    const reference =
      `GM-${Date.now()}-${crypto
        .randomBytes(5)
        .toString("hex")
        .toUpperCase()}`;

    // =================================================
    // VALIDATE DELIVERY INFORMATION
    // =================================================

    const rawDelivery = req.body?.metadata?.delivery;

    if (
      !rawDelivery ||
      typeof rawDelivery !== "object" ||
      Array.isArray(rawDelivery)
    ) {
      return res.status(400).json({
        success: false,
        message: "Delivery information is required.",
      });
    }

    const delivery = {};

    for (const field of [
      "firstName",
      "lastName",
      "email",
      "phone",
      "address",
      "city",
      "state",
    ]) {
      const value = String(
        rawDelivery[field] || ""
      ).trim();

      if (
        !value ||
        value.length > (
          field === "address" ? 500 : 150
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Please complete valid delivery information.",
        });
      }

      delivery[field] = value;
    }

    // =================================================
    // SAVE FIXED CHECKOUT SNAPSHOT
    // =================================================

    const snapshot = {
      schema_version: 1,
      delivery,
      order_currency: orderCurrency,
      order_total_minor: orderTotalMinor,
      expected_kobo: expectedKobo,
      items,
    };

    const metadata = {
      goldmart_reference: reference,
      goldmart_user_id: Number(req.user.id),
      goldmart_order_currency: orderCurrency,
      goldmart_order_total_minor: orderTotalMinor,
    };

    // =================================================
    // INITIALIZE PAYSTACK TRANSACTION
    // =================================================

    const transaction = await fetchPaystack(
      "/transaction/initialize",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          amount: expectedKobo,
          currency: "NGN",
          reference,
          callback_url:
            `${FRONTEND_URL}/order-success`,
          metadata,
        }),
      }
    );

    // =================================================
    // SAVE PAYMENT IN NEON
    // =================================================

    await pool.query(
      `
      INSERT INTO payments (
        user_id,
        reference,
        amount,
        currency,
        status,
        payment_method,
        checkout_snapshot,
        exchange_rate
      )
      VALUES (
        $1, $2, $3, 'NGN', 'pending',
        $4, $5::jsonb, $6
      )
      `,
      [
        req.user.id,
        reference,
        (expectedKobo / 100).toFixed(2),
        [
          "card",
          "transfer",
          "wallet",
        ].includes(
          req.body?.metadata?.payment_method
        )
          ? req.body.metadata.payment_method
          : "paystack",
        JSON.stringify(snapshot),
        USD_TO_NGN_RATE,
      ]
    );

    return res.json({
      success: true,
      message: "Payment initialized successfully.",
      payment: {
        reference,
        authorization_url:
          transaction.authorization_url,
        access_code:
          transaction.access_code,
        amount_ngn: expectedKobo / 100,
        amount_usd:
          orderCurrency === "USD"
            ? orderTotalMinor / 100
            : Number(
                (
                  expectedKobo /
                  (100 * USD_TO_NGN_RATE)
                ).toFixed(2)
              ),
        currency: "NGN",
        exchange_rate: USD_TO_NGN_RATE,
        status: "pending",
      },
    });
  } catch (error) {
    console.error(
      "Payment initialization error:",
      error.message
    );

    res.status(
      error.httpStatus ||
      (
        error.message.includes("monetary")
          ? 400
          : 500
      )
    ).json({
      success: false,
      message: error.httpStatus
        ? "Unable to start payment with Paystack."
        : "Unable to initialize payment safely. Try again later.",
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
        return res.status(503).json({
          success: false,
          message:
            "Payment provider is not configured.",
        });
      }

      const reference = String(
        req.params.reference || ""
      ).trim();

      const paymentResult = await pool.query(
        `
        SELECT
          id,
          user_id,
          order_id,
          reference,
          amount,
          currency,
          status
        FROM payments
        WHERE reference = $1
          AND user_id = $2
        LIMIT 1
        `,
        [reference, req.user.id]
      );

      if (!paymentResult.rows.length) {
        return res.status(404).json({
          success: false,
          message:
            "Payment not found for this account.",
        });
      }

      const payment = paymentResult.rows[0];

      // Prevent repeated verification requests
      // from creating duplicate payments.

      if (payment.status === "success") {
        return res.json({
          success: true,
          message: "Payment already verified.",
          payment: {
            reference,
            status: "success",
            order_id: payment.order_id,
            amount_ngn: Number(payment.amount),
            currency: "NGN",
          },
        });
      }

      // =================================================
      // VERIFY DIRECTLY WITH PAYSTACK
      // =================================================

      const transaction = await fetchPaystack(
        `/transaction/verify/${encodeURIComponent(
          reference
        )}`,
        { method: "GET" }
      );

      const expectedKobo = Math.round(
        Number(payment.amount) * 100
      );

      const actualKobo = Number(
        transaction.amount
      );

      // =================================================
      // VALIDATE REFERENCE, CURRENCY AND AMOUNT
      // =================================================

      if (
        String(transaction.reference) !== reference ||
        String(transaction.currency).toUpperCase() !==
          "NGN" ||
        !Number.isSafeInteger(actualKobo) ||
        actualKobo !== expectedKobo
      ) {
        await pool.query(
          `
          UPDATE payments
          SET
            status = 'needs_review',
            updated_at = NOW()
          WHERE id = $1
            AND status <> 'success'
          `,
          [payment.id]
        );

        return res.status(409).json({
          success: false,
          message:
            "Payment details need manual review. If you were charged, do not pay again. Contact GoldMart support with your reference.",
        });
      }

      // =================================================
      // CHECK PAYSTACK TRANSACTION STATUS
      // =================================================

      const providerStatus = String(
        transaction.status || ""
      ).toLowerCase();

      if (providerStatus !== "success") {
        await pool.query(
          `
          UPDATE payments
          SET
            status = $1,
            updated_at = NOW()
          WHERE id = $2
            AND status <> 'success'
          `,
          [
            providerStatus === "failed"
              ? "failed"
              : "pending",
            payment.id,
          ]
        );

        return res.status(409).json({
          success: false,
          message:
            providerStatus === "failed"
              ? "Payment was not completed."
              : "Payment is still pending confirmation. Do not make another payment yet.",
        });
      }

      // =================================================
      // MARK VERIFIED PAYMENT SUCCESSFUL
      // =================================================

      await pool.query(
        `
        UPDATE payments
        SET
          status = 'success',
          updated_at = NOW()
        WHERE id = $1
        `,
        [payment.id]
      );

      return res.json({
        success: true,
        message:
          "Payment verified successfully.",
        payment: {
          reference,
          status: "success",
          order_id: payment.order_id,
          amount_ngn: Number(payment.amount),
          currency: "NGN",
        },
      });
    } catch (error) {
      console.error(
        "Payment verification error:",
        error.message
      );

      res.status(error.httpStatus || 500).json({
        success: false,
        message:
          "Payment verification is temporarily unavailable. If you were charged, do not pay again; retry confirmation later.",
      });
    }
  }
);

// =====================================================
// GET A PAYMENT
// =====================================================

router.get(
  "/:reference",
  protect,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          id,
          order_id,
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
          String(
            req.params.reference || ""
          ).trim(),
          req.user.id,
        ]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Payment not found.",
        });
      }

      return res.json({
        success: true,
        payment: result.rows[0],
      });
    } catch (error) {
      console.error(
        "Get payment error:",
        error.message
      );

      res.status(500).json({
        success: false,
        message: "Unable to fetch payment.",
      });
    }
  }
);

module.exports = router;

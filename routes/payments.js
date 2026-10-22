
const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

const PAYSTACK_SECRET_KEY = String(
  process.env.PAYSTACK_SECRET_KEY || ""
);

const TEST_KEY_READY =
  PAYSTACK_SECRET_KEY.startsWith("sk_test_");

const FRONTEND_URL = String(
  process.env.FRONTEND_URL || "http://localhost:3000"
).replace(/\/$/, "");

const USD_TO_NGN_RATE = Number(
  process.env.USD_TO_NGN_RATE || 1500
);

// =====================================================
// TEST PAYMENT PROTECTION
// =====================================================

// Live charges are deliberately disabled while
// GoldMart's order and payout flows are tested.

function requireTestProvider(res) {
  if (TEST_KEY_READY) {
    return true;
  }

  res.status(503).json({
    success: false,
    message:
      "Test checkout is unavailable. Configure a Paystack test key; live charges are disabled.",
  });

  return false;
}

// =====================================================
// MONEY HELPERS
// =====================================================

function toMinor(value) {
  const str = String(value).trim();

  if (
    !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(str)
  ) {
    throw new Error(
      "Invalid monetary amount in cart."
    );
  }

  const [whole, decimals = ""] =
    str.split(".");

  const minor =
    Number(whole) * 100 +
    Number(decimals.padEnd(2, "0"));

  if (
    !Number.isSafeInteger(minor) ||
    minor < 0
  ) {
    throw new Error(
      "Monetary amount is too large."
    );
  }

  return minor;
}

function currencyOf(value) {
  return String(value || "USD")
    .trim()
    .toUpperCase();
}

function validKobo(value) {
  const amount = Number(value);

  return Number.isSafeInteger(amount) &&
    amount > 0
    ? amount
    : null;
}

// =====================================================
// PAYSTACK API HELPER
// =====================================================

async function fetchPaystack(
  path,
  options = {}
) {
  const response = await fetch(
    `https://api.paystack.co${path}`,
    {
      ...options,

      headers: {
        Authorization:
          `Bearer ${PAYSTACK_SECRET_KEY}`,

        Accept: "application/json",

        ...(options.headers || {}),
      },

      signal:
        AbortSignal.timeout(10000),
    }
  );

  const payload = await response.json();

  if (
    !response.ok ||
    payload.status !== true ||
    !payload.data
  ) {
    const error = new Error(
      "Paystack could not confirm this request."
    );

    error.httpStatus = 502;
    throw error;
  }

  return payload.data;
}

// =====================================================
// VALIDATE VERIFIED PAYMENT DETAILS
// =====================================================

function matchesVerifiedPayment(
  transaction,
  payment
) {
  const snapshot =
    payment.checkout_snapshot;

  if (
    !snapshot ||
    typeof snapshot !== "object"
  ) {
    return false;
  }

  const expected =
    validKobo(
      snapshot.expected_kobo
    );

  const providerAmount =
    validKobo(
      transaction.amount
    );

  const metadata =
    transaction.metadata;

  if (
    !expected ||
    !providerAmount ||
    !metadata ||
    typeof metadata !== "object"
  ) {
    return false;
  }

  let storedAmount;

  try {
    storedAmount = toMinor(
      payment.amount
    );
  } catch {
    return false;
  }

  return (
    transaction.status === "success" &&

    transaction.domain === "test" &&

    transaction.reference ===
      payment.reference &&

    currencyOf(
      transaction.currency
    ) === "NGN" &&

    currencyOf(
      payment.currency
    ) === "NGN" &&

    providerAmount === expected &&

    storedAmount === expected &&

    metadata.goldmart_reference ===
      payment.reference &&

    Number(
      metadata.goldmart_user_id
    ) === Number(
      payment.user_id
    ) &&

    String(
      metadata.goldmart_order_currency
    ) === String(
      snapshot.order_currency
    ) &&

    Number(
      metadata.goldmart_order_total_minor
    ) === Number(
      snapshot.order_total_minor
    ) &&

    Number.isSafeInteger(
      Number(
        snapshot.order_total_minor
      )
    ) &&

    Number(
      snapshot.order_total_minor
    ) > 0 &&

    ["USD", "NGN"].includes(
      snapshot.order_currency
    ) &&

    Array.isArray(
      snapshot.items
    ) &&

    snapshot.items.length > 0
  );
}

// =====================================================
// PAYMENT CONFIGURATION
//
// GET /api/payments/config
// =====================================================

router.get(
  "/config",
  protect,
  (req, res) => {
    res.json({
      success: true,

      configured:
        TEST_KEY_READY,

      test_mode:
        TEST_KEY_READY,

      currency: "NGN",

      usd_to_ngn_rate:
        USD_TO_NGN_RATE,
    });
  }
);

// =====================================================
// INITIALIZE TEST PAYMENT
//
// POST /api/payments/initialize
// =====================================================

router.post(
  "/initialize",
  protect,
  async (req, res) => {
    if (!requireTestProvider(res)) {
      return;
    }

    try {
      if (
        !Number.isFinite(
          USD_TO_NGN_RATE
        ) ||
        USD_TO_NGN_RATE <= 0
      ) {
        return res.status(503).json({
          success: false,
          message:
            "Checkout conversion rate is not configured.",
        });
      }

      // ================================================
      // VALIDATE EMAIL
      // ================================================

      const email = String(
        req.body?.email || ""
      ).trim();

      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          email
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "A valid email is required.",
        });
      }

      // ================================================
      // LOAD CART FROM DATABASE
      // ================================================

      const cart = await pool.query(
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
          ON p.id = ci.product_id AND p.is_active = TRUE

        WHERE c.user_id = $1

        ORDER BY p.id
        `,
        [req.user.id]
      );

      if (!cart.rows.length) {
        return res.status(400).json({
          success: false,
          message:
            "Your cart is empty.",
        });
      }

      // ================================================
      // CHECK CURRENCY
      // ================================================

      const currencies = [
        ...new Set(
          cart.rows.map(
            (row) =>
              currencyOf(
                row.currency
              )
          )
        ),
      ];

      if (
        currencies.length !== 1 ||
        !["USD", "NGN"].includes(
          currencies[0]
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Checkout requires one supported currency: USD or NGN.",
        });
      }

      const orderCurrency =
        currencies[0];

      let orderTotalMinor = 0;

      const items = [];

      // ================================================
      // CALCULATE CART TOTAL
      // ================================================

      for (const row of cart.rows) {
        const quantity = Number(
          row.quantity
        );

        if (
          !Number.isSafeInteger(
            quantity
          ) ||
          quantity <= 0 ||
          quantity >
            Number(row.stock)
        ) {
          return res.status(409).json({
            success: false,
            message:
              `${row.name} is out of stock or has an invalid quantity. Update your cart.`,
          });
        }

        const unitPriceMinor =
          toMinor(row.price);

        if (
          unitPriceMinor <= 0
        ) {
          return res.status(409).json({
            success: false,
            message:
              `The price for ${row.name} needs correction before checkout.`,
          });
        }

        const lineTotal =
          unitPriceMinor *
          quantity;

        if (
          !Number.isSafeInteger(
            lineTotal
          ) ||
          !Number.isSafeInteger(
            orderTotalMinor +
            lineTotal
          )
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Cart total exceeds the supported limit.",
          });
        }

        orderTotalMinor +=
          lineTotal;

        items.push({
          product_id:
            Number(
              row.product_id
            ),

          name:
            String(row.name),

          seller_id:
            row.seller_id == null
              ? null
              : Number(
                  row.seller_id
                ),

          quantity,

          unit_price_minor:
            unitPriceMinor,
        });
      }

      // ================================================
      // COMPARE CHECKOUT AMOUNT
      // ================================================

      const requestedCurrency =
        currencyOf(
          req.body?.currency ||
          orderCurrency
        );

      if (
        requestedCurrency !==
          orderCurrency ||

        (
          req.body?.amount != null &&
          toMinor(
            req.body.amount
          ) !==
            orderTotalMinor
        )
      ) {
        return res.status(409).json({
          success: false,
          message:
            "Your cart prices have changed. Refresh checkout before paying.",
        });
      }

      // ================================================
      // CONVERT TO PAYSTACK NGN KOBO
      // ================================================

      const expectedKobo =
        orderCurrency === "USD"
          ? Math.round(
              orderTotalMinor *
              USD_TO_NGN_RATE
            )
          : orderTotalMinor;

      if (
        !validKobo(
          expectedKobo
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Payment amount cannot be calculated safely.",
        });
      }

      // ================================================
      // VALIDATE DELIVERY
      // ================================================

      const rawDelivery =
        req.body?.metadata
          ?.delivery;

      if (
        !rawDelivery ||
        typeof rawDelivery !==
          "object" ||
        Array.isArray(
          rawDelivery
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Delivery information is required.",
        });
      }

      const delivery = {};

      for (
        const field of [
          "firstName",
          "lastName",
          "email",
          "phone",
          "address",
          "city",
          "state",
        ]
      ) {
        const value = String(
          rawDelivery[field] ||
          ""
        ).trim();

        if (
          !value ||
          value.length >
            (
              field === "address"
                ? 500
                : 150
            )
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Please complete valid delivery information.",
          });
        }

        delivery[field] =
          value;
      }

      // ================================================
      // PAYMENT REFERENCE
      // ================================================

      const reference =
        `GM-${Date.now()}-${crypto
          .randomBytes(5)
          .toString("hex")
          .toUpperCase()}`;

      // ================================================
      // CHECKOUT SNAPSHOT
      // ================================================

      const snapshot = {
        schema_version: 1,

        delivery,

        order_currency:
          orderCurrency,

        order_total_minor:
          orderTotalMinor,

        expected_kobo:
          expectedKobo,

        items,
      };

      const metadata = {
        goldmart_reference:
          reference,

        goldmart_user_id:
          Number(
            req.user.id
          ),

        goldmart_order_currency:
          orderCurrency,

        goldmart_order_total_minor:
          orderTotalMinor,
      };

      // ================================================
      // INITIALIZE PAYSTACK TEST TRANSACTION
      // ================================================

      const transaction =
        await fetchPaystack(
          "/transaction/initialize",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              email,

              amount:
                expectedKobo,

              currency: "NGN",

              reference,

              callback_url:
                `${FRONTEND_URL}/order-success`,

              metadata,
            }),
          }
        );

      // ================================================
      // SAVE PENDING PAYMENT
      // ================================================

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
          $1,
          $2,
          $3,
          'NGN',
          'pending',
          $4,
          $5::jsonb,
          $6
        )
        `,
        [
          req.user.id,

          reference,

          (
            expectedKobo / 100
          ).toFixed(2),

          [
            "card",
            "transfer",
            "wallet",
          ].includes(
            req.body?.metadata
              ?.payment_method
          )
            ? req.body.metadata
                .payment_method
            : "paystack",

          JSON.stringify(
            snapshot
          ),

          USD_TO_NGN_RATE,
        ]
      );

      return res.json({
        success: true,

        message:
          "Test payment initialized successfully.",

        payment: {
          reference,

          authorization_url:
            transaction.authorization_url,

          access_code:
            transaction.access_code,

          amount_ngn:
            expectedKobo / 100,

          amount_usd:
            orderCurrency === "USD"
              ? orderTotalMinor / 100
              : Number(
                  (
                    expectedKobo /
                    (
                      100 *
                      USD_TO_NGN_RATE
                    )
                  ).toFixed(2)
                ),

          currency: "NGN",

          exchange_rate:
            USD_TO_NGN_RATE,

          status: "pending",
        },
      });
    } catch (error) {
      console.error(
        "Payment initialization error:",
        error.message
      );

      const status =
        error.httpStatus ||
        (
          /monetary|large/i.test(
            error.message
          )
            ? 400
            : 500
        );

      return res
        .status(status)
        .json({
          success: false,

          message:
            status === 400
              ? "Invalid cart amount. Refresh your checkout."
              : "Unable to initialize test payment. Try again later.",
        });
    }
  }
);

// =====================================================
// VERIFY TEST PAYMENT
//
// GET /api/payments/verify/:reference
// =====================================================

router.get(
  "/verify/:reference",
  protect,
  async (req, res) => {
    if (
      !requireTestProvider(
        res
      )
    ) {
      return;
    }

    const reference = String(
      req.params.reference ||
      ""
    ).trim();

    if (
      !/^GM-[A-Za-z0-9-]{1,240}$/.test(
        reference
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid payment reference.",
      });
    }

    let client;
    let inTransaction = false;

    try {
      // ================================================
      // FIND BUYER'S PAYMENT
      // ================================================

      const lookup =
        await pool.query(
          `
          SELECT
            id,
            user_id,
            order_id,
            reference,
            amount,
            currency,
            status,
            checkout_snapshot

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
        !lookup.rows.length
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Payment not found for this account.",
        });
      }

      const existing =
        lookup.rows[0];

      // Already verified payments should
      // not be processed twice.

      if (
        existing.status ===
        "success"
      ) {
        return res.json({
          success: true,

          message:
            "Payment already verified.",

          payment: {
            reference,

            status: "success",

            order_id:
              existing.order_id,

            amount_ngn:
              Number(
                existing.amount
              ),

            currency: "NGN",
          },
        });
      }

      if (
        existing.status ===
        "needs_review"
      ) {
        return res.status(409).json({
          success: false,
          message:
            "This payment requires support review. If you were charged, do not pay again.",
        });
      }

      // ================================================
      // VERIFY DIRECTLY WITH PAYSTACK
      // ================================================

      const transaction =
        await fetchPaystack(
          `/transaction/verify/${encodeURIComponent(
            reference
          )}`,
          {
            method: "GET",
          }
        );

      // ================================================
      // LOCK PAYMENT BEFORE UPDATE
      // ================================================

      client =
        await pool.connect();

      await client.query(
        "BEGIN"
      );

      inTransaction = true;

      const currentResult =
        await client.query(
          `
          SELECT
            id,
            user_id,
            order_id,
            reference,
            amount,
            currency,
            status,
            checkout_snapshot

          FROM payments

          WHERE reference = $1
            AND user_id = $2

          FOR UPDATE
          `,
          [
            reference,
            req.user.id,
          ]
        );

      const current =
        currentResult.rows[0];

      if (!current) {
        await client.query(
          "ROLLBACK"
        );

        inTransaction =
          false;

        return res.status(404).json({
          success: false,
          message:
            "Payment not found.",
        });
      }

      // Webhook may already have verified
      // the payment while this ran.

      if (
        current.status ===
        "success"
      ) {
        await client.query(
          "COMMIT"
        );

        inTransaction =
          false;

        return res.json({
          success: true,

          message:
            "Payment already verified.",

          payment: {
            reference,

            status: "success",

            order_id:
              current.order_id,

            amount_ngn:
              Number(
                current.amount
              ),

            currency: "NGN",
          },
        });
      }

      if (
        current.status ===
        "needs_review"
      ) {
        await client.query(
          "ROLLBACK"
        );

        inTransaction =
          false;

        return res.status(409).json({
          success: false,
          message:
            "Payment requires support review. Do not pay again if you were charged.",
        });
      }

      // ================================================
      // SUCCESSFUL PROVIDER PAYMENT
      // ================================================

      if (
        transaction.status ===
        "success"
      ) {
        if (
          !matchesVerifiedPayment(
            transaction,
            current
          )
        ) {
          await client.query(
            `
            UPDATE payments

            SET
              status =
                'needs_review',

              updated_at =
                NOW()

            WHERE id = $1
              AND status <>
                'success'
            `,
            [
              current.id
            ]
          );

          await client.query(
            "COMMIT"
          );

          inTransaction =
            false;

          return res.status(409).json({
            success: false,

            message:
              "Payment details need manual review. If you were charged, do not pay again.",
          });
        }

        // Only verified test payments
        // may be marked successful.

        await client.query(
          `
          UPDATE payments

          SET
            status = 'success',

            updated_at = NOW()

          WHERE id = $1
            AND status <>
              'success'
          `,
          [
            current.id
          ]
        );

        await client.query(
          "COMMIT"
        );

        inTransaction =
          false;

        return res.json({
          success: true,

          message:
            "Test payment verified successfully.",

          payment: {
            reference,

            status: "success",

            order_id:
              current.order_id,

            amount_ngn:
              Number(
                current.amount
              ),

            currency: "NGN",
          },
        });
      }

      // ================================================
      // PENDING OR FAILED PAYMENT
      // ================================================

      const nextStatus =
        transaction.status ===
        "failed"
          ? "failed"
          : "pending";

      await client.query(
        `
        UPDATE payments

        SET
          status = $1,

          updated_at =
            NOW()

        WHERE id = $2
          AND status <>
            'success'
        `,
        [
          nextStatus,
          current.id,
        ]
      );

      await client.query(
        "COMMIT"
      );

      inTransaction =
        false;

      return res.status(409).json({
        success: false,

        message:
          nextStatus ===
          "failed"
            ? "Payment was not completed."
            : "Payment is pending confirmation. Do not make another payment yet.",
      });
    } catch (error) {
      if (
        inTransaction &&
        client
      ) {
        await client
          .query("ROLLBACK")
          .catch(() => {});
      }

      console.error(
        "Payment verification error:",
        error.message
      );

      return res
        .status(
          error.httpStatus ||
          500
        )
        .json({
          success: false,

          message:
            "Payment verification is temporarily unavailable. If charged, do not pay again.",
        });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

// =====================================================
// GET PAYMENT STATUS
//
// GET /api/payments/:reference
// =====================================================

router.get(
  "/:reference",
  protect,
  async (req, res) => {
    try {
      const result =
        await pool.query(
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
              req.params.reference ||
              ""
            ).trim(),

            req.user.id,
          ]
        );

      if (
        !result.rows.length
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
        error.message
      );

      return res.status(500).json({
        success: false,

        message:
          "Unable to fetch payment.",
      });
    }
  }
);

module.exports = router;

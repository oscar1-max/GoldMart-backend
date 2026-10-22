
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const routes = require("./routes");
const reportsRoutes = require("./routes/reports");
const wishlistRoutes = require("./routes/wishlist");
const messagesRoutes = require("./routes/messages");

const pool = require("./db");

const { finalizeOrder } = require("./services/finalizeOrder");
const app = express();
const PORT = process.env.PORT || 4000;

app.use(
  cors({
    origin: true,
    credentials: true,
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
    ],
  })
);

// =====================================================
// PAYSTACK TEST WEBHOOK
// =====================================================

const WEBHOOK_TEST_ENABLED =
  process.env.ENABLE_PAYSTACK_WEBHOOKS_TEST === "true" &&
  String(process.env.PAYSTACK_SECRET_KEY || "")
    .startsWith("sk_test_");

function storedKobo(amount) {
  const text = String(amount).trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    return null;
  }

  const [whole, fractional = ""] =
    text.split(".");

  const result =
    Number(whole) * 100 +
    Number(fractional.padEnd(2, "0"));

  return Number.isSafeInteger(result) &&
    result > 0
    ? result
    : null;
}

// This must be registered BEFORE express.json().

app.post(
  "/api/payments/webhook",
  express.raw({
    type: "application/json",
    limit: "128kb",
  }),
  async (req, res) => {
    if (!WEBHOOK_TEST_ENABLED) {
      return res.status(503).json({
        success: false,
        message:
          "Test webhook processing is disabled.",
      });
    }

    const header =
      req.get("x-paystack-signature") || "";

    const raw = req.body;
    const key = process.env.PAYSTACK_SECRET_KEY;

    if (
      !Buffer.isBuffer(raw) ||
      !/^[a-f0-9]{128}$/i.test(header)
    ) {
      return res.status(401).json({
        success: false,
      });
    }

    const expected = crypto
      .createHmac("sha512", key)
      .update(raw)
      .digest();

    const supplied =
      Buffer.from(header, "hex");

    if (
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(
        supplied,
        expected
      )
    ) {
      return res.status(401).json({
        success: false,
      });
    }

    let event;

    try {
      event = JSON.parse(
        raw.toString("utf8")
      );
    } catch {
      return res.status(400).json({
        success: false,
      });
    }

    // Only process successful charge notifications.
    // Refund reconciliation remains separate.

    if (event?.event !== "charge.success") {
      return res.status(200).json({
        received: true,
      });
    }

    const reference =
      event?.data?.reference;

    if (
      typeof reference !== "string" ||
      !/^GM-[A-Za-z0-9-]{1,240}$/.test(
        reference
      )
    ) {
      return res.status(200).json({
        received: true,
      });
    }

    try {
      // Independently verify with Paystack.

      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(
          reference
        )}`,
        {
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(
            10000
          ),
        }
      );

      const verified =
        await response.json();

      if (
        !response.ok ||
        verified.status !== true ||
        !verified.data
      ) {
        throw new Error(
          "Unable to confirm webhook payment with Paystack."
        );
      }

      const provider = verified.data;

      const client =
        await pool.connect();

      let released = false;
      try {
        await client.query("BEGIN");

        const result =
          await client.query(
            `
            SELECT
              id,
              user_id,
              reference,
              amount,
              currency,
              status,
              checkout_snapshot
            FROM payments
            WHERE reference = $1
            FOR UPDATE
            `,
            [reference]
          );

        if (!result.rows.length) {
          await client.query(
            "ROLLBACK"
          );

          return res.status(503).json({
            received: false,
          });
        }

        const payment = result.rows[0];

        // Repeated successful webhooks must
        // not create duplicate effects.

        if (
          payment.status === "success"
        ) {
          await client.query(
            "COMMIT"
          );

          client.release(); released = true;
        const finalized = await finalizeOrder(payment.user_id, reference);
          return res.status(finalized.status < 300 ? 200 : 503).json({ received: finalized.status < 300 });
        }

        const expectedKobo = Number(
          payment.checkout_snapshot
            ?.expected_kobo
        );

        const eventKobo = Number(
          event.data?.amount
        );

        const providerKobo = Number(
          provider.amount
        );

        const valid =
          provider.status ===
            "success" &&
          provider.domain ===
            "test" &&
          provider.reference ===
            reference &&
          String(
            provider.currency
          ).toUpperCase() === "NGN" &&
          String(
            event.data?.currency
          ).toUpperCase() === "NGN" &&
          String(
            payment.currency
          ).toUpperCase() === "NGN" &&
          Number.isSafeInteger(
            expectedKobo
          ) &&
          expectedKobo > 0 &&
          Number.isSafeInteger(
            providerKobo
          ) &&
          providerKobo ===
            expectedKobo &&
          Number.isSafeInteger(
            eventKobo
          ) &&
          eventKobo ===
            expectedKobo &&
          storedKobo(
            payment.amount
          ) === expectedKobo &&
          Number.isSafeInteger(
            Number(payment.user_id)
          ) &&
          Number(
            provider.metadata
              ?.goldmart_user_id
          ) ===
            Number(payment.user_id);

        if (!valid) {
          await client.query(
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

          await client.query(
            "COMMIT"
          );

          console.error(
            "Paystack webhook: payment requires review.",
            reference
          );

          return res.status(200).json({
            received: true,
          });
        }

        // Commit verification, then finalize through the same idempotent
        // order service used by the browser. Release this connection first.

        await client.query(
          `
          UPDATE payments
          SET
            status = 'success',
            updated_at = NOW()
          WHERE id = $1
            AND status <> 'success'
          `,
          [payment.id]
        );

        await client.query(
          "COMMIT"
        );

        client.release(); released = true;
        const finalized = await finalizeOrder(payment.user_id, reference);
        return res.status(finalized.status < 300 ? 200 : 503).json({ received: finalized.status < 300 });
      } catch (error) {
        if (!released) await client.query("ROLLBACK").catch(() => {});

        throw error;
      } finally {
        if (!released) client.release();
      }
    } catch (error) {
      console.error(
        "Paystack webhook verification error:",
        error.message
      );

      return res.status(503).json({
        received: false,
      });
    }
  }
);

// Existing API JSON parsing continues here.

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

// =====================================================
// DATABASE SETUP
// =====================================================

const { setupDatabase } = require("./services/databaseSetup");

// =====================================================
// EXISTING API ROUTES
// =====================================================

app.use("/api", routes);

app.use(
  "/api/reports",
  reportsRoutes
);

app.use(
  "/api/wishlist",
  wishlistRoutes
);

app.use(
  "/api/messages",
  messagesRoutes
);

// =====================================================
// HOME
// =====================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "GoldMart API is running",
  });
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, message: "GoldMart backend is healthy", payments: "test-only" });
  } catch {
    res.status(503).json({ success: false, message: "Database temporarily unavailable" });
  }
});

// =====================================================
// 404 HANDLER
// =====================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
    path: req.originalUrl,
  });
});

// =====================================================
// ERROR HANDLER
// =====================================================

app.use(
  (error, req, res, next) => {
    console.error(
      "Unhandled server error:",
      error
    );

    res.status(error.status === 400 ? 400 : 500).json({
      success: false,
      message: error.status === 400 ? "Invalid request body" : "Internal server error",
    });
  }
);

// =====================================================
// START SERVER
// =====================================================

async function start() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required. Use a random value of at least 32 characters.");
  }
  await setupDatabase();
  return app.listen(PORT, () => console.log(`GoldMart API running on port ${PORT}`));
}

if (require.main === module) {
  start().catch(error => {
    console.error("GoldMart startup failed:", error.message);
    process.exit(1);
  });
}
module.exports = { app, start };

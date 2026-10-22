
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const routes = require("./routes");
const reportsRoutes = require("./routes/reports");
const wishlistRoutes = require("./routes/wishlist");
const messagesRoutes = require("./routes/messages");

const testDatabaseConnection = require("./database");
const pool = require("./db");

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

          return res.status(200).json({
            received: true,
          });
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

        // Update payment verification only.
        // Existing order endpoint remains
        // responsible for creating orders
        // and seller allocations.

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

        return res.status(200).json({
          received: true,
        });
      } catch (error) {
        await client
          .query("ROLLBACK")
          .catch(() => {});

        throw error;
      } finally {
        client.release();
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

app.use(express.json());

// =====================================================
// DATABASE SETUP
// =====================================================

async function setupDatabase() {
  try {
    const migrations = [
      `ALTER TABLE products ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'USD';`,

      `UPDATE products SET currency = 'USD' WHERE currency IS NULL OR currency = '';`,

      `CREATE TABLE IF NOT EXISTS seller_reviews (
        id SERIAL PRIMARY KEY,
        buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        review TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`,

      `CREATE UNIQUE INDEX IF NOT EXISTS seller_reviews_buyer_seller_order_unique
       ON seller_reviews(buyer_id, seller_id, order_id);`,

      `CREATE INDEX IF NOT EXISTS seller_reviews_seller_id_idx
       ON seller_reviews(seller_id);`,

      `CREATE INDEX IF NOT EXISTS seller_reviews_buyer_id_idx
       ON seller_reviews(buyer_id);`,

      `CREATE INDEX IF NOT EXISTS seller_reviews_order_id_idx
       ON seller_reviews(order_id);`,

      `CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        type VARCHAR(50) DEFAULT 'general',
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`,

      `CREATE INDEX IF NOT EXISTS notifications_user_id_idx
       ON notifications(user_id);`,

      `CREATE INDEX IF NOT EXISTS notifications_is_read_idx
       ON notifications(is_read);`,

      `CREATE INDEX IF NOT EXISTS notifications_created_at_idx
       ON notifications(created_at);`,

      `CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reference VARCHAR(255) UNIQUE NOT NULL,
        amount DECIMAL(12, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        payment_method VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`,

      `ALTER TABLE payments
       ADD COLUMN IF NOT EXISTS checkout_snapshot JSONB;`,

      `ALTER TABLE payments
       ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(20, 8);`,

      `CREATE INDEX IF NOT EXISTS payments_user_id_idx
       ON payments(user_id);`,

      `CREATE INDEX IF NOT EXISTS payments_order_id_idx
       ON payments(order_id);`,

      `CREATE INDEX IF NOT EXISTS payments_reference_idx
       ON payments(reference);`,

      `CREATE INDEX IF NOT EXISTS payments_status_idx
       ON payments(status);`,

      `CREATE TABLE IF NOT EXISTS seller_order_allocations (
        id BIGSERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
        payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
        seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        currency VARCHAR(3) NOT NULL CHECK (currency IN ('USD', 'NGN')),
        gross_minor BIGINT NOT NULL CHECK (gross_minor > 0),
        status VARCHAR(30) NOT NULL DEFAULT 'pending_review'
          CHECK (status IN (
            'pending_review',
            'blocked',
            'eligible',
            'settled',
            'voided'
          )),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (order_id, seller_id),
        UNIQUE (payment_id, seller_id)
      );`,

      `CREATE INDEX IF NOT EXISTS seller_order_allocations_seller_idx
       ON seller_order_allocations(seller_id);`,

      `CREATE INDEX IF NOT EXISTS seller_order_allocations_order_idx
       ON seller_order_allocations(order_id);`,

      `CREATE INDEX IF NOT EXISTS seller_order_allocations_payment_idx
       ON seller_order_allocations(payment_id);`,

      `CREATE INDEX IF NOT EXISTS seller_order_allocations_status_idx
       ON seller_order_allocations(status);`,

      `CREATE INDEX IF NOT EXISTS seller_order_allocations_seller_status_idx
       ON seller_order_allocations(seller_id, status);`,

      `ALTER TABLE users
       ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;`,

      `CREATE INDEX IF NOT EXISTS users_is_banned_idx
       ON users(is_banned);`,

      `CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reported_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason VARCHAR(100) NOT NULL,
        message TEXT,
        status VARCHAR(30) NOT NULL DEFAULT 'pending'
          CHECK (status IN (
            'pending',
            'reviewed',
            'resolved',
            'dismissed'
          )),
        admin_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CHECK (reporter_id <> reported_user_id)
      );`,

      `CREATE INDEX IF NOT EXISTS reports_reporter_id_idx
       ON reports(reporter_id);`,

      `CREATE INDEX IF NOT EXISTS reports_reported_user_id_idx
       ON reports(reported_user_id);`,

      `CREATE INDEX IF NOT EXISTS reports_status_idx
       ON reports(status);`,

      `CREATE INDEX IF NOT EXISTS reports_created_at_idx
       ON reports(created_at);`,

      `CREATE TABLE IF NOT EXISTS wishlist_items (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, product_id)
      );`,

      `CREATE INDEX IF NOT EXISTS wishlist_items_user_id_idx
       ON wishlist_items(user_id);`,

      `CREATE INDEX IF NOT EXISTS wishlist_items_product_id_idx
       ON wishlist_items(product_id);`,

      `CREATE INDEX IF NOT EXISTS wishlist_items_created_at_idx
       ON wishlist_items(created_at);`,

      `CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (buyer_id, seller_id, product_id),
        CHECK (buyer_id <> seller_id)
      );`,

      `CREATE INDEX IF NOT EXISTS conversations_buyer_id_idx
       ON conversations(buyer_id);`,

      `CREATE INDEX IF NOT EXISTS conversations_seller_id_idx
       ON conversations(seller_id);`,

      `CREATE INDEX IF NOT EXISTS conversations_updated_at_idx
       ON conversations(updated_at);`,

      `CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`,

      `CREATE INDEX IF NOT EXISTS messages_conversation_id_idx
       ON messages(conversation_id);`,

      `CREATE INDEX IF NOT EXISTS messages_sender_id_idx
       ON messages(sender_id);`,

      `CREATE INDEX IF NOT EXISTS messages_created_at_idx
       ON messages(created_at);`,
      // Earlier installations lack this field; notifications queries rely on it.
      `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL;`,
    ];

    for (const sql of migrations) {
      await pool.query(sql);
    }

    console.log(
      "Seller allocation schema checked successfully"
    );

    console.log(
      "Database setup completed successfully"
    );
  } catch (error) {
    console.error(
      "Database setup error:",
      error.message
    );
  }
}

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

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "GoldMart backend is healthy",
  });
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

    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
);

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, async () => {
  console.log(
    `GoldMart API running on port ${PORT}`
  );

  await testDatabaseConnection();

  await setupDatabase();
});

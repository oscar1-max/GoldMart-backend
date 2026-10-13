
"use strict";

// GoldMart Customer Support API
// File: routes/support.js

const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function currentUserId(req) {
  return positiveId(req.user?.id ?? req.user?.userId);
}

function isSupportAdmin(userId) {
  const adminId = positiveId(process.env.ADMIN_USER_ID);
  return Boolean(adminId && userId && adminId === userId);
}

function errorJson(res, status, message) {
  return res.status(status).json({
    success: false,
    message,
  });
}

const CATEGORIES = new Set([
  "order",
  "delivery",
  "payment",
  "refund",
  "account",
  "seller",
  "other",
]);

const STATUSES = new Set([
  "open",
  "in_progress",
  "resolved",
  "closed",
]);

// Create support tables when the support API is first used.
// PostgreSQL must allow table and index creation.

let schemaPromise;

function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS support_tickets (
          id BIGSERIAL PRIMARY KEY,

          user_id INTEGER NOT NULL
            REFERENCES users(id)
            ON DELETE CASCADE,

          category VARCHAR(30) NOT NULL
            CHECK (
              category IN (
                'order',
                'delivery',
                'payment',
                'refund',
                'account',
                'seller',
                'other'
              )
            ),

          subject VARCHAR(120) NOT NULL,

          status VARCHAR(20) NOT NULL DEFAULT 'open'
            CHECK (
              status IN (
                'open',
                'in_progress',
                'resolved',
                'closed'
              )
            ),

          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS support_messages (
          id BIGSERIAL PRIMARY KEY,

          ticket_id BIGINT NOT NULL
            REFERENCES support_tickets(id)
            ON DELETE CASCADE,

          sender_id INTEGER NOT NULL
            REFERENCES users(id)
            ON DELETE CASCADE,

          message TEXT NOT NULL
            CHECK (char_length(message) BETWEEN 1 AND 5000),

          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS
        support_tickets_user_updated_idx
        ON support_tickets (user_id, updated_at DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS
        support_tickets_status_updated_idx
        ON support_tickets (status, updated_at DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS
        support_messages_ticket_id_idx
        ON support_messages (ticket_id, id)
      `);
    })().catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }

  return schemaPromise;
}

// Every support endpoint requires authentication.

router.use(protect);

router.use(async (req, res, next) => {
  if (!currentUserId(req)) {
    return errorJson(res, 401, "Authentication required");
  }

  try {
    await ensureSchema();
    next();
  } catch (error) {
    console.error("Support database setup error:", error);

    return errorJson(
      res,
      503,
      "Support is temporarily unavailable"
    );
  }
});

// =====================================================
// GET CUSTOMER'S SUPPORT TICKETS
// GET /api/support
// =====================================================

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          id,
          category,
          subject,
          status,
          created_at,
          updated_at
        FROM support_tickets
        WHERE user_id = $1
        ORDER BY updated_at DESC, id DESC
        LIMIT 100
      `,
      [currentUserId(req)]
    );

    return res.json({
      success: true,
      tickets: result.rows,
    });
  } catch (error) {
    console.error("List support tickets error:", error);

    return errorJson(
      res,
      500,
      "Unable to load support tickets"
    );
  }
});

// =====================================================
// CREATE SUPPORT TICKET
// POST /api/support
// =====================================================

router.post("/", async (req, res) => {
  const category =
    typeof req.body?.category === "string"
      ? req.body.category.trim().toLowerCase()
      : "";

  const subject =
    typeof req.body?.subject === "string"
      ? req.body.subject.trim()
      : "";

  const message =
    typeof req.body?.message === "string"
      ? req.body.message.trim()
      : "";

  if (!CATEGORIES.has(category)) {
    return errorJson(
      res,
      400,
      "Select a valid support category"
    );
  }

  if (subject.length < 5 || subject.length > 120) {
    return errorJson(
      res,
      400,
      "Subject must be 5 to 120 characters"
    );
  }

  if (message.length < 10 || message.length > 5000) {
    return errorJson(
      res,
      400,
      "Message must be 10 to 5000 characters"
    );
  }

  const userId = currentUserId(req);

  const client = await pool.connect().catch((error) => {
    console.error("Support connection error:", error);
    return null;
  });

  if (!client) {
    return errorJson(
      res,
      503,
      "Support is temporarily unavailable"
    );
  }

  try {
    await client.query("BEGIN");

    const ticketResult = await client.query(
      `
        INSERT INTO support_tickets (
          user_id,
          category,
          subject
        )
        VALUES ($1, $2, $3)
        RETURNING
          id,
          category,
          subject,
          status,
          created_at,
          updated_at
      `,
      [userId, category, subject]
    );

    const ticket = ticketResult.rows[0];

    await client.query(
      `
        INSERT INTO support_messages (
          ticket_id,
          sender_id,
          message
        )
        VALUES ($1, $2, $3)
      `,
      [ticket.id, userId, message]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      ticket,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    console.error("Create support ticket error:", error);

    return errorJson(
      res,
      500,
      "Unable to create support ticket"
    );
  } finally {
    client.release();
  }
});

// =====================================================
// ADMIN: LIST ALL SUPPORT TICKETS
// GET /api/support/admin/tickets
// =====================================================

router.get("/admin/tickets", async (req, res) => {
  if (!isSupportAdmin(currentUserId(req))) {
    return errorJson(res, 403, "Admin access required");
  }

  try {
    const result = await pool.query(`
      SELECT
        t.id,
        t.user_id,
        t.category,
        t.subject,
        t.status,
        t.created_at,
        t.updated_at
      FROM support_tickets t
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT 200
    `);

    return res.json({
      success: true,
      tickets: result.rows,
    });
  } catch (error) {
    console.error(
      "Admin list support tickets error:",
      error
    );

    return errorJson(
      res,
      500,
      "Unable to load support inbox"
    );
  }
});

// =====================================================
// ADMIN: UPDATE TICKET STATUS
// PATCH /api/support/admin/:ticketId/status
// =====================================================

router.patch(
  "/admin/:ticketId/status",
  async (req, res) => {
    if (!isSupportAdmin(currentUserId(req))) {
      return errorJson(
        res,
        403,
        "Admin access required"
      );
    }

    const ticketId = positiveId(req.params.ticketId);

    const status =
      typeof req.body?.status === "string"
        ? req.body.status.trim().toLowerCase()
        : "";

    if (!ticketId || !STATUSES.has(status)) {
      return errorJson(
        res,
        400,
        "Invalid ticket or status"
      );
    }

    try {
      const result = await pool.query(
        `
          UPDATE support_tickets
          SET
            status = $2,
            updated_at = NOW()
          WHERE id = $1
          RETURNING
            id,
            user_id,
            category,
            subject,
            status,
            created_at,
            updated_at
        `,
        [ticketId, status]
      );

      if (!result.rows.length) {
        return errorJson(
          res,
          404,
          "Ticket not found"
        );
      }

      return res.json({
        success: true,
        ticket: result.rows[0],
      });
    } catch (error) {
      console.error(
        "Update support status error:",
        error
      );

      return errorJson(
        res,
        500,
        "Unable to update ticket status"
      );
    }
  }
);

// =====================================================
// CHECK TICKET ACCESS
// =====================================================

async function authorizedTicket(ticketId, userId) {
  const result = await pool.query(
    `
      SELECT
        id,
        user_id,
        category,
        subject,
        status,
        created_at,
        updated_at
      FROM support_tickets
      WHERE id = $1
    `,
    [ticketId]
  );

  const ticket = result.rows[0];

  if (!ticket) {
    return {
      status: 404,
      message: "Ticket not found",
    };
  }

  if (
    Number(ticket.user_id) !== userId &&
    !isSupportAdmin(userId)
  ) {
    return {
      status: 404,
      message: "Ticket not found",
    };
  }

  return { ticket };
}

// =====================================================
// VIEW A SUPPORT TICKET AND ITS MESSAGES
// GET /api/support/:ticketId
// =====================================================

router.get("/:ticketId", async (req, res) => {
  const ticketId = positiveId(req.params.ticketId);

  if (!ticketId) {
    return errorJson(res, 400, "Invalid ticket ID");
  }

  try {
    const access = await authorizedTicket(
      ticketId,
      currentUserId(req)
    );

    if (!access.ticket) {
      return errorJson(
        res,
        access.status,
        access.message
      );
    }

    const result = await pool.query(
      `
        SELECT
          id,
          sender_id,
          message,
          created_at
        FROM support_messages
        WHERE ticket_id = $1
        ORDER BY id ASC
        LIMIT 300
      `,
      [ticketId]
    );

    return res.json({
      success: true,
      ticket: access.ticket,
      messages: result.rows,
    });
  } catch (error) {
    console.error("View support ticket error:", error);

    return errorJson(
      res,
      500,
      "Unable to load ticket"
    );
  }
});

// =====================================================
// REPLY TO A SUPPORT TICKET
// POST /api/support/:ticketId/replies
// =====================================================

router.post(
  "/:ticketId/replies",
  async (req, res) => {
    const ticketId = positiveId(req.params.ticketId);

    const message =
      typeof req.body?.message === "string"
        ? req.body.message.trim()
        : "";

    if (!ticketId) {
      return errorJson(
        res,
        400,
        "Invalid ticket ID"
      );
    }

    if (message.length < 1 || message.length > 5000) {
      return errorJson(
        res,
        400,
        "Reply must be 1 to 5000 characters"
      );
    }

    const userId = currentUserId(req);

    const client = await pool.connect().catch((error) => {
      console.error("Support connection error:", error);
      return null;
    });

    if (!client) {
      return errorJson(
        res,
        503,
        "Support is temporarily unavailable"
      );
    }

    try {
      await client.query("BEGIN");

      const locked = await client.query(
        `
          SELECT
            id,
            user_id,
            status
          FROM support_tickets
          WHERE id = $1
          FOR UPDATE
        `,
        [ticketId]
      );

      const ticket = locked.rows[0];

      if (
        !ticket ||
        (
          Number(ticket.user_id) !== userId &&
          !isSupportAdmin(userId)
        )
      ) {
        await client.query("ROLLBACK");

        return errorJson(
          res,
          404,
          "Ticket not found"
        );
      }

      if (ticket.status === "closed") {
        await client.query("ROLLBACK");

        return errorJson(
          res,
          409,
          "This ticket is closed"
        );
      }

      const result = await client.query(
        `
          INSERT INTO support_messages (
            ticket_id,
            sender_id,
            message
          )
          VALUES ($1, $2, $3)
          RETURNING
            id,
            sender_id,
            message,
            created_at
        `,
        [ticketId, userId, message]
      );

      await client.query(
        `
          UPDATE support_tickets
          SET updated_at = NOW()
          WHERE id = $1
        `,
        [ticketId]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        reply: result.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});

      console.error(
        "Reply to support ticket error:",
        error
      );

      return errorJson(
        res,
        500,
        "Unable to send reply"
      );
    } finally {
      client.release();
    }
  }
);

module.exports = router;

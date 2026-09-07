const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();

async function getAuthenticatedUser(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query(
      `SELECT id, name, email, role, is_banned
       FROM users
       WHERE id = $1`,
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const user = result.rows[0];

    if (user.is_banned) {
      return null;
    }

    return user;
  } catch (error) {
    return null;
  }
}

/*
  GET /api/messages/conversations

  Returns conversations belonging to the logged-in user.
*/
router.get("/conversations", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const result = await pool.query(
      `
      SELECT
        c.id,
        c.buyer_id,
        c.seller_id,
        c.product_id,
        c.created_at,
        c.updated_at,

        CASE
          WHEN c.buyer_id = $1 THEN seller.id
          ELSE buyer.id
        END AS other_user_id,

        CASE
          WHEN c.buyer_id = $1 THEN seller.name
          ELSE buyer.name
        END AS other_user_name,

        p.name AS product_name,

        (
          SELECT m.message
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) AS last_message,

        (
          SELECT m.created_at
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) AS last_message_at,

        (
          SELECT COUNT(*)
          FROM messages m
          WHERE m.conversation_id = c.id
            AND m.sender_id <> $1
            AND m.is_read = FALSE
        ) AS unread_count

      FROM conversations c

      JOIN users buyer
        ON buyer.id = c.buyer_id

      JOIN users seller
        ON seller.id = c.seller_id

      LEFT JOIN products p
        ON p.id = c.product_id

      WHERE c.buyer_id = $1
         OR c.seller_id = $1

      ORDER BY c.updated_at DESC
      `,
      [user.id]
    );

    res.json({
      success: true,
      conversations: result.rows,
    });
  } catch (error) {
    console.error("Get conversations error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to load conversations",
    });
  }
});

/*
  POST /api/messages/conversations

  Creates or finds a buyer/seller conversation.

  Body:
  {
    sellerId,
    productId
  }

  Only buyers can start a conversation with a seller.
*/
router.post("/conversations", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const { sellerId, productId = null } = req.body;

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: "sellerId is required",
      });
    }

    const sellerResult = await pool.query(
      `SELECT id, name, role, is_banned
       FROM users
       WHERE id = $1`,
      [sellerId]
    );

    if (sellerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Seller not found",
      });
    }

    const seller = sellerResult.rows[0];

    if (seller.role !== "seller") {
      return res.status(400).json({
        success: false,
        message: "Selected user is not a seller",
      });
    }

    if (seller.is_banned) {
      return res.status(403).json({
        success: false,
        message: "This seller is unavailable",
      });
    }

    if (user.id === seller.id) {
      return res.status(400).json({
        success: false,
        message: "You cannot start a conversation with yourself",
      });
    }

    if (user.role !== "customer") {
      return res.status(403).json({
        success: false,
        message: "Only buyers can start seller conversations",
      });
    }

    if (productId) {
      const productResult = await pool.query(
        `SELECT id, seller_id
         FROM products
         WHERE id = $1`,
        [productId]
      );

      if (productResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Product not found",
        });
      }

      if (Number(productResult.rows[0].seller_id) !== Number(sellerId)) {
        return res.status(400).json({
          success: false,
          message: "This product does not belong to this seller",
        });
      }
    }

    const result = await pool.query(
      `
      INSERT INTO conversations
        (buyer_id, seller_id, product_id)
      VALUES
        ($1, $2, $3)
      ON CONFLICT (buyer_id, seller_id, product_id)
      DO UPDATE SET updated_at = CURRENT_TIMESTAMP
      RETURNING *
      `,
      [user.id, sellerId, productId]
    );

    res.status(201).json({
      success: true,
      conversation: result.rows[0],
    });
  } catch (error) {
    console.error("Create conversation error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create conversation",
    });
  }
});

/*
  GET /api/messages/conversations/:conversationId

  Returns one conversation and its messages.
*/
router.get("/conversations/:conversationId", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const conversationId = Number(req.params.conversationId);

    if (!Number.isInteger(conversationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID",
      });
    }

    const conversationResult = await pool.query(
      `
      SELECT
        c.id,
        c.buyer_id,
        c.seller_id,
        c.product_id,
        c.created_at,
        c.updated_at,

        buyer.name AS buyer_name,
        seller.name AS seller_name,

        p.name AS product_name

      FROM conversations c

      JOIN users buyer
        ON buyer.id = c.buyer_id

      JOIN users seller
        ON seller.id = c.seller_id

      LEFT JOIN products p
        ON p.id = c.product_id

      WHERE c.id = $1
        AND (c.buyer_id = $2 OR c.seller_id = $2)
      `,
      [conversationId, user.id]
    );

    if (conversationResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found",
      });
    }

    const conversation = conversationResult.rows[0];

    const messagesResult = await pool.query(
      `
      SELECT
        m.id,
        m.conversation_id,
        m.sender_id,
        m.message,
        m.is_read,
        m.created_at,
        u.name AS sender_name

      FROM messages m

      JOIN users u
        ON u.id = m.sender_id

      WHERE m.conversation_id = $1

      ORDER BY m.created_at ASC
      `,
      [conversationId]
    );

    /*
      Mark messages sent by the other participant as read.
    */
    await pool.query(
      `
      UPDATE messages
      SET is_read = TRUE
      WHERE conversation_id = $1
        AND sender_id <> $2
        AND is_read = FALSE
      `,
      [conversationId, user.id]
    );

    res.json({
      success: true,
      conversation,
      messages: messagesResult.rows,
    });
  } catch (error) {
    console.error("Get conversation error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to load conversation",
    });
  }
});

/*
  POST /api/messages/conversations/:conversationId

  Send a message.
*/
router.post("/conversations/:conversationId", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const conversationId = Number(req.params.conversationId);
    const { message } = req.body;

    if (!Number.isInteger(conversationId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID",
      });
    }

    if (
      typeof message !== "string" ||
      message.trim().length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Message cannot be empty",
      });
    }

    const cleanMessage = message.trim();

    if (cleanMessage.length > 5000) {
      return res.status(400).json({
        success: false,
        message: "Message is too long",
      });
    }

    const conversationResult = await pool.query(
      `
      SELECT id, buyer_id, seller_id
      FROM conversations
      WHERE id = $1
        AND (buyer_id = $2 OR seller_id = $2)
      `,
      [conversationId, user.id]
    );

    if (conversationResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Conversation not found",
      });
    }

    const conversation = conversationResult.rows[0];

    const recipientId =
      Number(conversation.buyer_id) === Number(user.id)
        ? conversation.seller_id
        : conversation.buyer_id;

    const messageResult = await pool.query(
      `
      INSERT INTO messages
        (conversation_id, sender_id, message)
      VALUES
        ($1, $2, $3)
      RETURNING id, conversation_id, sender_id, message, is_read, created_at
      `,
      [conversationId, user.id, cleanMessage]
    );

    await pool.query(
      `
      UPDATE conversations
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [conversationId]
    );

    /*
      Create a notification only for the recipient.
      This will also help us later fix the notification privacy issue.
    */
    await pool.query(
      `
      INSERT INTO notifications
        (user_id, type, message)
      VALUES
        ($1, $2, $3)
      `,
      [
        recipientId,
        "message",
        `${user.name} sent you a new message.`,
      ]
    );

    res.status(201).json({
      success: true,
      message: messageResult.rows[0],
    });
  } catch (error) {
    console.error("Send message error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to send message",
    });
  }
});

/*
  DELETE /api/messages/conversations/:conversationId

  We don't physically delete conversations.
  This endpoint is intentionally disabled for now so chat history
  cannot accidentally disappear.
*/
router.delete("/conversations/:conversationId", async (req, res) => {
  return res.status(405).json({
    success: false,
    message: "Conversation deletion is not available",
  });
});

module.exports = router;

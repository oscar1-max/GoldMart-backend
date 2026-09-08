const express = require("express");
const pool = require("../db");
const jwt = require("jsonwebtoken");
const { protect } = require("../middleware/auth");

const router = express.Router();

function getUserId(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  try {
    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return Number(decoded.id || decoded.userId || decoded.user_id);
  } catch {
    return null;
  }
}

/*
  GET /api/messages/conversations

  Gets only conversations belonging to the
  currently logged-in buyer or seller.
*/
router.get("/conversations", protect, async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
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

        buyer.name AS buyer_name,
        seller.name AS seller_name,

        p.name AS product_name,

        (
          SELECT m.message
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) AS last_message,

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
      [userId]
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

  Creates or finds a conversation between
  the logged-in buyer and a seller.
*/
router.post("/conversations", protect, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { sellerId, productId } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: "sellerId is required",
      });
    }

    const sellerResult = await pool.query(
      `
      SELECT id, name, role
      FROM users
      WHERE id = $1
      `,
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

    if (Number(userId) === Number(sellerId)) {
      return res.status(400).json({
        success: false,
        message: "You cannot chat with yourself",
      });
    }

    let conversation;

    if (productId) {
      const existing = await pool.query(
        `
        SELECT *
        FROM conversations
        WHERE buyer_id = $1
          AND seller_id = $2
          AND product_id = $3
        LIMIT 1
        `,
        [userId, sellerId, productId]
      );

      if (existing.rows.length > 0) {
        conversation = existing.rows[0];
      } else {
        const created = await pool.query(
          `
          INSERT INTO conversations
            (buyer_id, seller_id, product_id)
          VALUES
            ($1, $2, $3)
          RETURNING *
          `,
          [userId, sellerId, productId]
        );

        conversation = created.rows[0];
      }
    } else {
      const existing = await pool.query(
        `
        SELECT *
        FROM conversations
        WHERE buyer_id = $1
          AND seller_id = $2
          AND product_id IS NULL
        LIMIT 1
        `,
        [userId, sellerId]
      );

      if (existing.rows.length > 0) {
        conversation = existing.rows[0];
      } else {
        const created = await pool.query(
          `
          INSERT INTO conversations
            (buyer_id, seller_id, product_id)
          VALUES
            ($1, $2, NULL)
          RETURNING *
          `,
          [userId, sellerId]
        );

        conversation = created.rows[0];
      }
    }

    res.json({
      success: true,
      conversation,
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

  Gets messages only if the logged-in user
  belongs to the conversation.
*/
router.get(
  "/conversations/:conversationId",
  protect,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const conversationId = Number(req.params.conversationId);

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized",
        });
      }

      if (!Number.isInteger(conversationId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid conversation ID",
        });
      }

      const conversationResult = await pool.query(
        `
        SELECT
          c.*,
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
          AND (
            c.buyer_id = $2
            OR c.seller_id = $2
          )
        `,
        [conversationId, userId]
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

      // Mark messages sent by the other person as read.
      await pool.query(
        `
        UPDATE messages
        SET is_read = TRUE
        WHERE conversation_id = $1
          AND sender_id <> $2
          AND is_read = FALSE
        `,
        [conversationId, userId]
      );

      res.json({
        success: true,
        conversation,
        messages: messagesResult.rows,
      });
    } catch (error) {
      console.error("Get messages error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to load messages",
      });
    }
  }
);


/*
  POST /api/messages/conversations/:conversationId

  Sends a message.
*/
router.post(
  "/conversations/:conversationId",
  protect,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const conversationId = Number(req.params.conversationId);
      const message = String(req.body.message || "").trim();

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized",
        });
      }

      if (!Number.isInteger(conversationId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid conversation ID",
        });
      }

      if (!message) {
        return res.status(400).json({
          success: false,
          message: "Message cannot be empty",
        });
      }

      if (message.length > 2000) {
        return res.status(400).json({
          success: false,
          message: "Message is too long",
        });
      }

      const conversationResult = await pool.query(
        `
        SELECT
          c.*,
          buyer.name AS buyer_name,
          seller.name AS seller_name
        FROM conversations c
        JOIN users buyer
          ON buyer.id = c.buyer_id
        JOIN users seller
          ON seller.id = c.seller_id
        WHERE c.id = $1
          AND (
            c.buyer_id = $2
            OR c.seller_id = $2
          )
        `,
        [conversationId, userId]
      );

      if (conversationResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Conversation not found",
        });
      }

      const conversation = conversationResult.rows[0];

      const senderResult = await pool.query(
        `
        SELECT id, name, role
        FROM users
        WHERE id = $1
        `,
        [userId]
      );

      const sender = senderResult.rows[0];

      const recipientId =
        Number(conversation.buyer_id) === Number(userId)
          ? conversation.seller_id
          : conversation.buyer_id;

      const messageResult = await pool.query(
        `
        INSERT INTO messages
          (conversation_id, sender_id, message)
        VALUES
          ($1, $2, $3)
        RETURNING *
        `,
        [conversationId, userId, message]
      );

      await pool.query(
        `
        UPDATE conversations
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [conversationId]
      );

      // Private notification: only the recipient gets this notification.
      await pool.query(
        `
        INSERT INTO notifications
          (user_id, title, message, type)
        VALUES
          ($1, $2, $3, $4)
        `,
        [
          recipientId,
          "New Message",
          `${sender.name} sent you a new message.`,
          "message",
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
  }
);


module.exports = router;


const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// HELPERS
// =====================================================

function validId(value) {
  const id = Number(value);

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

function getUserId(req) {
  return validId(req.user?.id ?? req.user?.userId);
}

// =====================================================
// GET ALL BUYER / SELLER CONVERSATIONS
// =====================================================

router.get("/conversations", protect, async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
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

        buyer.name AS buyer_name,
        seller.name AS seller_name,

        CASE
          WHEN c.buyer_id = $1
            THEN seller.name
          ELSE buyer.name
        END AS other_user_name,

        CASE
          WHEN c.buyer_id = $1
            THEN c.seller_id
          ELSE c.buyer_id
        END AS other_user_id,

        p.name AS product_name,
        p.image_url AS product_image,

        lm.message AS last_message,
        lm.created_at AS last_message_at,

        (
          SELECT COUNT(*)
          FROM messages m2
          WHERE m2.conversation_id = c.id
            AND m2.sender_id <> $1
            AND m2.is_read = FALSE
        ) AS unread_count

      FROM conversations c

      INNER JOIN users buyer
        ON buyer.id = c.buyer_id

      INNER JOIN users seller
        ON seller.id = c.seller_id

      LEFT JOIN products p
        ON p.id = c.product_id

      LEFT JOIN LATERAL (
        SELECT
          m.message,
          m.created_at
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      ) lm ON TRUE

      WHERE c.buyer_id = $1
         OR c.seller_id = $1

      ORDER BY c.updated_at DESC, c.id DESC
      `,
      [userId]
    );

    return res.json({
      success: true,
      conversations: result.rows,
    });
  } catch (error) {
    console.error("Get conversations error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load conversations",
    });
  }
});

// =====================================================
// CREATE OR FIND A BUYER / SELLER CONVERSATION
// =====================================================

router.post("/conversations", protect, async (req, res) => {
  try {
    const buyerId = getUserId(req);
    const sellerId = validId(req.body?.sellerId);

    const productId =
      req.body?.productId == null ||
      req.body.productId === ""
        ? null
        : validId(req.body.productId);

    if (!buyerId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: "Valid seller ID is required",
      });
    }

    if (
      req.body?.productId != null &&
      req.body.productId !== "" &&
      !productId
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID",
      });
    }

    if (buyerId === sellerId) {
      return res.status(400).json({
        success: false,
        message: "You cannot chat with yourself",
      });
    }

    const sellerResult = await pool.query(
      `
      SELECT id, name, role
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [sellerId]
    );

    if (!sellerResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Seller not found",
      });
    }

    // Validate the product belongs to the selected seller.
    if (productId) {
      const productResult = await pool.query(
        `
        SELECT id
        FROM products
        WHERE id = $1
          AND seller_id = $2
        LIMIT 1
        `,
        [productId, sellerId]
      );

      if (!productResult.rows.length) {
        return res.status(400).json({
          success: false,
          message:
            "This product does not belong to the selected seller",
        });
      }
    } else if (
      sellerResult.rows[0].role !== "seller"
    ) {
      const sellerProducts = await pool.query(
        `
        SELECT id
        FROM products
        WHERE seller_id = $1
        LIMIT 1
        `,
        [sellerId]
      );

      if (!sellerProducts.rows.length) {
        return res.status(400).json({
          success: false,
          message: "Selected account is not a seller",
        });
      }
    }

    // Find an existing conversation.
    const existing = await pool.query(
      `
      SELECT id
      FROM conversations
      WHERE buyer_id = $1
        AND seller_id = $2
        AND product_id IS NOT DISTINCT FROM $3::integer
      ORDER BY id ASC
      LIMIT 1
      `,
      [buyerId, sellerId, productId]
    );

    if (existing.rows.length) {
      return res.json({
        success: true,
        existing: true,
        conversation: {
          id: existing.rows[0].id,
        },
      });
    }

    const created = await pool.query(
      `
      INSERT INTO conversations (
        buyer_id,
        seller_id,
        product_id
      )
      VALUES ($1, $2, $3)
      RETURNING
        id,
        buyer_id,
        seller_id,
        product_id,
        created_at,
        updated_at
      `,
      [buyerId, sellerId, productId]
    );

    return res.status(201).json({
      success: true,
      existing: false,
      conversation: created.rows[0],
    });
  } catch (error) {
    console.error("Create conversation error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create conversation",
    });
  }
});

// =====================================================
// GET ONE CONVERSATION AND ITS MESSAGES
// =====================================================

router.get(
  "/conversations/:conversationId",
  protect,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const conversationId = validId(
        req.params.conversationId
      );

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      if (!conversationId) {
        return res.status(400).json({
          success: false,
          message: "Invalid conversation ID",
        });
      }

      // Only the buyer or seller can open this chat.
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

          p.name AS product_name,
          p.image_url AS product_image

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

        LIMIT 1
        `,
        [conversationId, userId]
      );

      if (!conversationResult.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Conversation not found",
        });
      }

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

        ORDER BY m.created_at ASC, m.id ASC
        `,
        [conversationId]
      );

      // Mark only the other person's messages as read.
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

      return res.json({
        success: true,
        conversation: conversationResult.rows[0],
        messages: messagesResult.rows,
      });
    } catch (error) {
      console.error("Get conversation error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to load conversation",
      });
    }
  }
);

// =====================================================
// SEND MESSAGE AS BUYER OR SELLER
// =====================================================

router.post(
  "/conversations/:conversationId",
  protect,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const conversationId = validId(
        req.params.conversationId
      );

      const message =
        typeof req.body?.message === "string"
          ? req.body.message.trim()
          : "";

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      if (!conversationId) {
        return res.status(400).json({
          success: false,
          message: "Invalid conversation ID",
        });
      }

      if (!message || message.length > 5000) {
        return res.status(400).json({
          success: false,
          message:
            "Message must contain between 1 and 5000 characters",
        });
      }

      const conversationResult = await pool.query(
        `
        SELECT
          id,
          buyer_id,
          seller_id
        FROM conversations
        WHERE id = $1
          AND (
            buyer_id = $2
            OR seller_id = $2
          )
        LIMIT 1
        `,
        [conversationId, userId]
      );

      if (!conversationResult.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Conversation not found",
        });
      }

      const conversation = conversationResult.rows[0];

      const recipientId =
        Number(conversation.buyer_id) === userId
          ? Number(conversation.seller_id)
          : Number(conversation.buyer_id);

      const senderResult = await pool.query(
        `
        SELECT name
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
      );

      const senderName =
        senderResult.rows[0]?.name || "GoldMart user";

      // Save the actual chat message.
      const messageResult = await pool.query(
        `
        INSERT INTO messages (
          conversation_id,
          sender_id,
          message
        )
        VALUES ($1, $2, $3)
        RETURNING
          id,
          conversation_id,
          sender_id,
          message,
          is_read,
          created_at
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

      // =================================================
      // NOTIFY THE OTHER PERSON
      // =================================================

      try {
        await pool.query(
          `
          INSERT INTO notifications (
            user_id,
            type,
            title,
            message,
            is_read,
            conversation_id
          )
          VALUES (
            $1,
            'message',
            'New message',
            $2,
            FALSE,
            $3
          )
          `,
          [
            recipientId,
            `${senderName} sent you a new message.`,
            conversationId,
          ]
        );
      } catch (notificationError) {
        // The message is still saved if the
        // notification could not be created.
        console.error(
          "Message notification error:",
          notificationError
        );
      }

      return res.status(201).json({
        success: true,
        message: {
          ...messageResult.rows[0],
          sender_name: senderName,
        },
      });
    } catch (error) {
      console.error("Send message error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to send message",
      });
    }
  }
);

module.exports = router;

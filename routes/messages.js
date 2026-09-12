const express = require("express");
const router = express.Router();

const pool = require("../db");
const { protect } = require("../middleware/auth");

/*
  GET /api/messages/conversations

  Get all conversations belonging to the logged-in user.
*/
router.get("/conversations", protect, async (req, res) => {
  try {
    const userId = Number(req.user.id);

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

        CASE
          WHEN c.buyer_id = $1 THEN seller.name
          ELSE buyer.name
        END AS other_user_name,

        CASE
          WHEN c.buyer_id = $1 THEN c.seller_id
          ELSE c.buyer_id
        END AS other_user_id,

        p.name AS product_name,
        p.image_url AS product_image,

        lm.message AS last_message,
        lm.created_at AS last_message_at,

        COALESCE(
          (
            SELECT COUNT(*)
            FROM messages m2
            WHERE m2.conversation_id = c.id
              AND m2.sender_id <> $1
              AND m2.is_read = FALSE
          ),
          0
        ) AS unread_count

      FROM conversations c

      JOIN users buyer
        ON buyer.id = c.buyer_id

      JOIN users seller
        ON seller.id = c.seller_id

      LEFT JOIN products p
        ON p.id = c.product_id

      LEFT JOIN LATERAL (
        SELECT
          m.message,
          m.created_at
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) lm ON TRUE

      WHERE c.buyer_id = $1
         OR c.seller_id = $1

      ORDER BY c.updated_at DESC
      `,
      [userId]
    );

    return res.json({
      success: true,
      conversations: result.rows,
    });
  } catch (error) {
    console.error("GET conversations error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load conversations",
    });
  }
});


/*
  POST /api/messages/conversations

  Create a buyer -> seller conversation.
*/
router.post("/conversations", protect, async (req, res) => {
  try {
    const buyerId = Number(req.user.id);
    const sellerId = Number(req.body.sellerId);

    const productId =
      req.body.productId === null ||
      req.body.productId === undefined ||
      req.body.productId === ""
        ? null
        : Number(req.body.productId);

    if (!buyerId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!sellerId || Number.isNaN(sellerId)) {
      return res.status(400).json({
        success: false,
        message: "Seller ID is required",
      });
    }

    if (buyerId === sellerId) {
      return res.status(400).json({
        success: false,
        message: "You cannot chat with yourself",
      });
    }

    /*
      Make sure the target user exists
      and is actually a seller.
    */
    const sellerCheck = await pool.query(
      `
      SELECT id, name, role
      FROM users
      WHERE id = $1
      `,
      [sellerId]
    );

    if (sellerCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Seller not found",
      });
    }

    if (sellerCheck.rows[0].role !== "seller") {
      return res.status(400).json({
        success: false,
        message: "Selected user is not a seller",
      });
    }

    /*
      If a product was supplied,
      make sure it exists.
    */
    if (productId !== null) {
      const productCheck = await pool.query(
        `
        SELECT id
        FROM products
        WHERE id = $1
        `,
        [productId]
      );

      if (productCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Product not found",
        });
      }
    }

    /*
      Check whether this conversation
      already exists.
    */
    let existing;

    if (productId === null) {
      existing = await pool.query(
        `
        SELECT id
        FROM conversations
        WHERE buyer_id = $1
          AND seller_id = $2
          AND product_id IS NULL
        LIMIT 1
        `,
        [buyerId, sellerId]
      );
    } else {
      existing = await pool.query(
        `
        SELECT id
        FROM conversations
        WHERE buyer_id = $1
          AND seller_id = $2
          AND product_id = $3
        LIMIT 1
        `,
        [buyerId, sellerId, productId]
      );
    }

    if (existing.rows.length > 0) {
      return res.json({
        success: true,
        conversation: {
          id: existing.rows[0].id,
        },
        existing: true,
      });
    }

    /*
      Create the conversation.
    */
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
      conversation: created.rows[0],
      existing: false,
    });
  } catch (error) {
    console.error("POST conversation error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create conversation",
    });
  }
});


/*
  GET /api/messages/conversations/:conversationId

  Load one conversation and all its messages.
*/
router.get(
  "/conversations/:conversationId",
  protect,
  async (req, res) => {
    try {
      const userId = Number(req.user.id);
      const conversationId = Number(req.params.conversationId);

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      if (!conversationId || Number.isNaN(conversationId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid conversation ID",
        });
      }

      /*
        Make sure the logged-in user
        belongs to this conversation.
      */
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

      if (conversationResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Conversation not found",
        });
      }

      /*
        Get all messages.
      */
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
        Mark messages from the other
        person as read.
      */
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
      console.error("GET conversation error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to load conversation",
      });
    }
  }
);


/*
  POST /api/messages/conversations/:conversationId

  Send a message.
*/
router.post(
  "/conversations/:conversationId",
  protect,
  async (req, res) => {
    try {
      const userId = Number(req.user.id);
      const conversationId = Number(req.params.conversationId);

      const message =
        typeof req.body.message === "string"
          ? req.body.message.trim()
          : "";

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      if (!conversationId || Number.isNaN(conversationId)) {
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

      if (message.length > 5000) {
        return res.status(400).json({
          success: false,
          message: "Message is too long",
        });
      }

      /*
        Find conversation and verify
        that the user belongs to it.
      */
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

      if (conversationResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Conversation not found",
        });
      }

      const conversation = conversationResult.rows[0];

      /*
        Work out who receives the message.
      */
      const recipientId =
        Number(conversation.buyer_id) === userId
          ? Number(conversation.seller_id)
          : Number(conversation.buyer_id);

      /*
        Get sender information.
      */
      const senderResult = await pool.query(
        `
        SELECT
          id,
          name
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
      );

      if (senderResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Sender account not found",
        });
      }

      const senderName = senderResult.rows[0].name;

      /*
        Save the message.
      */
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

      /*
        Update conversation activity.
      */
      await pool.query(
        `
        UPDATE conversations
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [conversationId]
      );

      /*
        Create a private notification
        for the person receiving the message.
      */
      try {
        await pool.query(
          `
          INSERT INTO notifications (
            user_id,
            type,
            title,
            message,
            is_read
          )
          VALUES (
            $1,
            'message',
            'New message',
            $2,
            FALSE
          )
          `,
          [
            recipientId,
            `${senderName} sent you a new message.`,
          ]
        );
      } catch (notificationError) {
        /*
          If notification creation fails,
          the actual chat message should
          still succeed.
        */
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
      console.error("POST message error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to send message",
      });
    }
  }
);


module.exports = router;

const express = require("express");
const router = express.Router();

const pool = require("../db");
const { protect } = require("../middleware/auth");

/*
  GET /api/messages/conversations

  Gets all conversations belonging to the logged-in user.
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

  Creates a buyer -> seller conversation.
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
      Make sure the target user really is a seller.
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
      If a product ID was supplied, make sure the product exists.
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
      Find an existing conversation first.

      We handle NULL product_id separately because PostgreSQL
      allows multiple NULL values in a normal UNIQUE constraint.
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
      Create a new conversation.
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


module.exports = router;

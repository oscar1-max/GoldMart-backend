const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// CREATE SELLER REVIEW
// =====================================================
router.post("/", protect, async (req, res) => {
  try {
    const { orderId, sellerId, rating, review } = req.body;

    if (!orderId || !sellerId || !rating) {
      return res.status(400).json({
        success: false,
        message: "Order ID, seller ID and rating are required",
      });
    }

    const numericRating = Number(rating);

    if (
      !Number.isInteger(numericRating) ||
      numericRating < 1 ||
      numericRating > 5
    ) {
      return res.status(400).json({
        success: false,
        message: "Rating must be between 1 and 5",
      });
    }

    // Make sure the order belongs to the buyer
    const orderResult = await pool.query(
      `
      SELECT id
      FROM orders
      WHERE id = $1
        AND user_id = $2
      `,
      [orderId, req.user.id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Make sure the seller actually sold a product in this order
    const sellerResult = await pool.query(
      `
      SELECT products.id
      FROM order_items
      JOIN products
        ON order_items.product_id = products.id
      WHERE order_items.order_id = $1
        AND products.seller_id = $2
      LIMIT 1
      `,
      [orderId, sellerId]
    );

    if (sellerResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "This seller is not connected to this order",
      });
    }

    // Only allow reviews after delivery
    const deliveryResult = await pool.query(
      `
      SELECT status
      FROM orders
      WHERE id = $1
      `,
      [orderId]
    );

    const status = deliveryResult.rows[0]?.status;

    if (status !== "delivered") {
      return res.status(400).json({
        success: false,
        message: "You can only review a seller after the order is delivered",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO seller_reviews
      (
        seller_id,
        buyer_id,
        order_id,
        rating,
        review
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        sellerId,
        req.user.id,
        orderId,
        numericRating,
        review?.trim() || null,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Seller review submitted successfully",
      review: result.rows[0],
    });
  } catch (error) {
    console.error("Create seller review error:", error);

    // Duplicate review
    if (error.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "You have already reviewed this order",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to submit seller review",
    });
  }
});

// =====================================================
// GET SELLER RATING
// =====================================================
router.get("/seller/:sellerId", async (req, res) => {
  try {
    const { sellerId } = req.params;

    const result = await pool.query(
      `
      SELECT
        COUNT(*)::INTEGER AS review_count,
        COALESCE(ROUND(AVG(rating), 1), 0) AS average_rating
      FROM seller_reviews
      WHERE seller_id = $1
      `,
      [sellerId]
    );

    res.json({
      success: true,
      rating: {
        average: Number(result.rows[0].average_rating),
        count: result.rows[0].review_count,
      },
    });
  } catch (error) {
    console.error("Get seller rating error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch seller rating",
    });
  }
});

// =====================================================
// GET SELLER REVIEWS
// =====================================================
router.get("/seller/:sellerId/reviews", async (req, res) => {
  try {
    const { sellerId } = req.params;

    const result = await pool.query(
      `
      SELECT
        seller_reviews.id,
        seller_reviews.rating,
        seller_reviews.review,
        seller_reviews.created_at,
        users.name AS buyer_name
      FROM seller_reviews
      JOIN users
        ON seller_reviews.buyer_id = users.id
      WHERE seller_reviews.seller_id = $1
      ORDER BY seller_reviews.created_at DESC
      `,
      [sellerId]
    );

    res.json({
      success: true,
      reviews: result.rows,
    });
  } catch (error) {
    console.error("Get seller reviews error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch seller reviews",
    });
  }
});

module.exports = router;

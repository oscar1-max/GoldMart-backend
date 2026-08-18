const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// BUYER — CREATE SELLER REVIEW
// =====================================================
router.post("/", protect, async (req, res) => {
  try {
    const { orderId, sellerId, rating, review } = req.body;

    const numericRating = Number(rating);
    const numericSellerId = Number(sellerId);
    const numericOrderId = Number(orderId);

    if (
      !Number.isInteger(numericOrderId) ||
      !Number.isInteger(numericSellerId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid order ID and seller ID are required",
      });
    }

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

    // Make sure the buyer actually bought from this seller.
    const purchaseResult = await pool.query(
      `
      SELECT orders.id
      FROM orders
      JOIN order_items
        ON orders.id = order_items.order_id
      JOIN products
        ON order_items.product_id = products.id
      WHERE orders.id = $1
        AND orders.user_id = $2
        AND products.seller_id = $3
      LIMIT 1
      `,
      [
        numericOrderId,
        req.user.id,
        numericSellerId,
      ]
    );

    if (purchaseResult.rows.length === 0) {
      return res.status(403).json({
        success: false,
        message:
          "You can only review a seller you purchased from",
      });
    }

    // Prevent duplicate reviews for the same seller/order.
    const existingReview = await pool.query(
      `
      SELECT id
      FROM seller_reviews
      WHERE buyer_id = $1
        AND seller_id = $2
        AND order_id = $3
      `,
      [
        req.user.id,
        numericSellerId,
        numericOrderId,
      ]
    );

    if (existingReview.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "You have already reviewed this seller for this order",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO seller_reviews
      (
        buyer_id,
        seller_id,
        order_id,
        rating,
        review
      )
      VALUES
      ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        req.user.id,
        numericSellerId,
        numericOrderId,
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
    const sellerId = Number(req.params.sellerId);

    if (!Number.isInteger(sellerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid seller ID",
      });
    }

    const ratingResult = await pool.query(
      `
      SELECT
        COUNT(*)::INTEGER AS review_count,
        COALESCE(ROUND(AVG(rating), 2), 0) AS average_rating
      FROM seller_reviews
      WHERE seller_id = $1
      `,
      [sellerId]
    );

    const reviewsResult = await pool.query(
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
      rating: ratingResult.rows[0],
      reviews: reviewsResult.rows,
    });
  } catch (error) {
    console.error("Get seller reviews error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch seller reviews",
    });
  }
});

// =====================================================
// BUYER — CHECK WHETHER THEY ALREADY REVIEWED
// =====================================================
router.get(
  "/check/:orderId/:sellerId",
  protect,
  async (req, res) => {
    try {
      const orderId = Number(req.params.orderId);
      const sellerId = Number(req.params.sellerId);

      const result = await pool.query(
        `
        SELECT
          id,
          rating,
          review,
          created_at
        FROM seller_reviews
        WHERE buyer_id = $1
          AND order_id = $2
          AND seller_id = $3
        `,
        [
          req.user.id,
          orderId,
          sellerId,
        ]
      );

      res.json({
        success: true,
        reviewed: result.rows.length > 0,
        review: result.rows[0] || null,
      });
    } catch (error) {
      console.error("Check seller review error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to check seller review",
      });
    }
  }
);

module.exports = router;

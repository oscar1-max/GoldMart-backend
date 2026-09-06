const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

router.use(protect);

// GET /api/wishlist
// Get the logged-in user's wishlist
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        wishlist_items.id AS wishlist_id,
        wishlist_items.created_at,
        products.*
      FROM wishlist_items
      INNER JOIN products
        ON wishlist_items.product_id = products.id
      WHERE wishlist_items.user_id = $1
      ORDER BY wishlist_items.created_at DESC
      `,
      [req.user.id]
    );

    res.json({
      success: true,
      wishlist: result.rows,
    });
  } catch (error) {
    console.error("Get wishlist error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch wishlist",
    });
  }
});

// GET /api/wishlist/check/:productId
// Check whether a product is already in the wishlist
router.get("/check/:productId", async (req, res) => {
  try {
    const { productId } = req.params;

    const result = await pool.query(
      `
      SELECT id
      FROM wishlist_items
      WHERE user_id = $1
        AND product_id = $2
      LIMIT 1
      `,
      [req.user.id, productId]
    );

    res.json({
      success: true,
      wishlisted: result.rows.length > 0,
    });
  } catch (error) {
    console.error("Check wishlist error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to check wishlist",
    });
  }
});

// POST /api/wishlist
// Add a product to wishlist
router.post("/", async (req, res) => {
  try {
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Product ID is required",
      });
    }

    // Make sure the product exists
    const product = await pool.query(
      `
      SELECT id
      FROM products
      WHERE id = $1
      LIMIT 1
      `,
      [productId]
    );

    if (product.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO wishlist_items (user_id, product_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, product_id)
      DO NOTHING
      RETURNING id, user_id, product_id, created_at
      `,
      [req.user.id, productId]
    );

    res.status(201).json({
      success: true,
      message:
        result.rows.length > 0
          ? "Product added to wishlist"
          : "Product is already in your wishlist",
      wishlistItem: result.rows[0] || null,
    });
  } catch (error) {
    console.error("Add wishlist error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to add product to wishlist",
    });
  }
});

// DELETE /api/wishlist/:productId
// Remove a product from wishlist
router.delete("/:productId", async (req, res) => {
  try {
    const { productId } = req.params;

    const result = await pool.query(
      `
      DELETE FROM wishlist_items
      WHERE user_id = $1
        AND product_id = $2
      RETURNING id
      `,
      [req.user.id, productId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product is not in your wishlist",
      });
    }

    res.json({
      success: true,
      message: "Product removed from wishlist",
    });
  } catch (error) {
    console.error("Remove wishlist error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to remove product from wishlist",
    });
  }
});

// DELETE /api/wishlist
// Remove everything from wishlist
router.delete("/", async (req, res) => {
  try {
    await pool.query(
      `
      DELETE FROM wishlist_items
      WHERE user_id = $1
      `,
      [req.user.id]
    );

    res.json({
      success: true,
      message: "Wishlist cleared",
    });
  } catch (error) {
    console.error("Clear wishlist error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to clear wishlist",
    });
  }
});

module.exports = router;

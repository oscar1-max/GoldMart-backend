const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// GET LOGGED-IN USER'S CART
// =====================================================

router.get("/", protect, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        cart_items.id,
        cart_items.quantity,

        products.id AS product_id,
        products.name,
        products.price,
        products.currency,
        products.image_url,
        products.stock,
        products.seller_id

      FROM carts

      INNER JOIN cart_items
        ON carts.id = cart_items.cart_id

      INNER JOIN products
        ON cart_items.product_id = products.id

      WHERE carts.user_id = $1

      ORDER BY cart_items.id DESC
      `,
      [req.user.id]
    );

    res.json({
      success: true,
      cart: result.rows,
    });
  } catch (error) {
    console.error(
      "Get cart error:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Failed to fetch cart",
    });
  }
});

// =====================================================
// ADD PRODUCT TO CART
// =====================================================

router.post("/", protect, async (req, res) => {
  try {
    const {
      productId,
      quantity = 1,
    } = req.body;

    const numericProductId =
      Number(productId);

    const numericQuantity =
      Number(quantity);

    if (
      !Number.isInteger(
        numericProductId
      ) ||
      numericProductId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Product ID is required",
      });
    }

    if (
      !Number.isInteger(
        numericQuantity
      ) ||
      numericQuantity < 1
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Quantity must be at least 1",
      });
    }

    const productResult =
      await pool.query(
        `
        SELECT
          id,
          stock,
          price,
          currency
        FROM products
        WHERE id = $1
        `,
        [numericProductId]
      );

    if (
      productResult.rows.length === 0
    ) {
      return res.status(404).json({
        success: false,
        message:
          "Product not found",
      });
    }

    const product =
      productResult.rows[0];

    if (
      Number(product.stock) <
      numericQuantity
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Not enough stock available",
      });
    }

    // =================================================
    // GET OR CREATE USER CART
    // =================================================

    let cartResult =
      await pool.query(
        `
        SELECT id
        FROM carts
        WHERE user_id = $1
        LIMIT 1
        `,
        [req.user.id]
      );

    let cartId;

    if (
      cartResult.rows.length === 0
    ) {
      const newCart =
        await pool.query(
          `
          INSERT INTO carts (user_id)
          VALUES ($1)
          RETURNING id
          `,
          [req.user.id]
        );

      cartId =
        newCart.rows[0].id;
    } else {
      cartId =
        cartResult.rows[0].id;
    }

    // =================================================
    // ADD OR INCREASE QUANTITY
    // =================================================

    const existingItem =
      await pool.query(
        `
        SELECT quantity
        FROM cart_items
        WHERE cart_id = $1
          AND product_id = $2
        `,
        [
          cartId,
          numericProductId,
        ]
      );

    if (
      existingItem.rows.length > 0
    ) {
      const newQuantity =
        Number(
          existingItem.rows[0]
            .quantity
        ) +
        numericQuantity;

      if (
        newQuantity >
        Number(product.stock)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Requested quantity exceeds available stock",
        });
      }

      await pool.query(
        `
        UPDATE cart_items
        SET quantity = $1
        WHERE cart_id = $2
          AND product_id = $3
        `,
        [
          newQuantity,
          cartId,
          numericProductId,
        ]
      );
    } else {
      await pool.query(
        `
        INSERT INTO cart_items (
          cart_id,
          product_id,
          quantity
        )
        VALUES ($1, $2, $3)
        `,
        [
          cartId,
          numericProductId,
          numericQuantity,
        ]
      );
    }

    res.status(201).json({
      success: true,
      message:
        "Product added to cart",
    });
  } catch (error) {
    console.error(
      "Add to cart error:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Failed to add product to cart",
    });
  }
});

// =====================================================
// SYNC FRONTEND CART WITH DATABASE CART
// =====================================================

router.put(
  "/sync",
  protect,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const {
        items = [],
      } = req.body;

      if (!Array.isArray(items)) {
        return res.status(400).json({
          success: false,
          message:
            "Cart items must be an array",
        });
      }

      await client.query(
        "BEGIN"
      );

      // =================================================
      // GET OR CREATE CART
      // =================================================

      let cartResult =
        await client.query(
          `
          SELECT id
          FROM carts
          WHERE user_id = $1
          LIMIT 1
          `,
          [req.user.id]
        );

      let cartId;

      if (
        cartResult.rows.length === 0
      ) {
        const newCart =
          await client.query(
            `
            INSERT INTO carts (user_id)
            VALUES ($1)
            RETURNING id
            `,
            [req.user.id]
          );

        cartId =
          newCart.rows[0].id;
      } else {
        cartId =
          cartResult.rows[0].id;
      }

      // =================================================
      // REMOVE OLD DATABASE CART
      // =================================================

      await client.query(
        `
        DELETE FROM cart_items
        WHERE cart_id = $1
        `,
        [cartId]
      );

      // =================================================
      // INSERT CURRENT FRONTEND CART
      // =================================================

      for (
        const item of items
      ) {
        const productId =
          Number(
            item.productId
          );

        const quantity =
          Number(
            item.quantity
          );

        if (
          !Number.isInteger(
            productId
          ) ||
          !Number.isInteger(
            quantity
          ) ||
          quantity <= 0
        ) {
          throw new Error(
            "Invalid cart item."
          );
        }

        const productResult =
          await client.query(
            `
            SELECT
              id,
              stock
            FROM products
            WHERE id = $1
            `,
            [productId]
          );

        if (
          productResult.rows
            .length === 0
        ) {
          throw new Error(
            `Product ${productId} was not found.`
          );
        }

        const product =
          productResult.rows[0];

        if (
          Number(product.stock) <
          quantity
        ) {
          throw new Error(
            `Product ${productId} does not have enough stock.`
          );
        }

        await client.query(
          `
          INSERT INTO cart_items (
            cart_id,
            product_id,
            quantity
          )
          VALUES ($1, $2, $3)
          `,
          [
            cartId,
            productId,
            quantity,
          ]
        );
      }

      await client.query(
        "COMMIT"
      );

      res.json({
        success: true,
        message:
          "Cart synchronized successfully",
      });
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "Sync cart error:",
        error
      );

      res.status(400).json({
        success: false,
        message:
          error instanceof Error
            ? error.message
            : "Failed to synchronize cart",
      });
    } finally {
      client.release();
    }
  }
);

// =====================================================
// REMOVE ONE PRODUCT
// =====================================================

router.delete(
  "/:productId",
  protect,
  async (req, res) => {
    try {
      const productId =
        Number(
          req.params.productId
        );

      if (
        !Number.isInteger(
          productId
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid product ID",
        });
      }

      await pool.query(
        `
        DELETE FROM cart_items
        WHERE cart_id = (
          SELECT id
          FROM carts
          WHERE user_id = $1
        )
        AND product_id = $2
        `,
        [
          req.user.id,
          productId,
        ]
      );

      res.json({
        success: true,
        message:
          "Product removed from cart",
      });
    } catch (error) {
      console.error(
        "Remove from cart error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to remove product from cart",
      });
    }
  }
);

// =====================================================
// CLEAR ENTIRE DATABASE CART
// =====================================================

router.delete(
  "/",
  protect,
  async (req, res) => {
    try {
      await pool.query(
        `
        DELETE FROM cart_items
        WHERE cart_id = (
          SELECT id
          FROM carts
          WHERE user_id = $1
        )
        `,
        [req.user.id]
      );

      res.json({
        success: true,
        message:
          "Cart cleared successfully",
      });
    } catch (error) {
      console.error(
        "Clear cart error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Failed to clear cart",
      });
    }
  }
);

module.exports = router;

const express = require("express");

const authRoutes = require("./auth");
const categoryRoutes = require("./categories");
const productRoutes = require("./products");
const cartRoutes = require("./cart");
const orderRoutes = require("./orders");
const paymentRoutes = require("./payments");
const sellerRoutes = require("./seller");
const reviewRoutes = require("./reviews");
const notificationRoutes = require("./notifications");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/categories", categoryRoutes);
router.use("/products", productRoutes);
router.use("/cart", cartRoutes);
router.use("/orders", orderRoutes);
router.use("/payments", paymentRoutes);
router.use("/seller", sellerRoutes);
router.use("/reviews", reviewRoutes);
router.use("/notifications", notificationRoutes);

module.exports = router;

const jwt = require("jsonwebtoken");
const pool = require("../db");

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Get the current user from the database.
    // This means a ban takes effect even if the user already has a valid JWT.
    const result = await pool.query(
      `SELECT id, name, email, role, is_banned
       FROM users
       WHERE id = $1`,
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "User account not found",
      });
    }

    const user = result.rows[0];

    // Only admins configured in ADMIN_USER_ID can continue using
    // the account even if there is an accidental banned flag.
    const adminIds = (process.env.ADMIN_USER_ID || "")
      .split(",")
      .map((id) => Number(id.trim()))
      .filter(Boolean);

    const isAdmin = adminIds.includes(Number(user.id));

    if (user.is_banned && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Your GoldMart account has been banned",
      });
    }

    // Keep the authenticated user available to the rest of the route.
    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      is_banned: user.is_banned,
    };

    next();
  } catch (error) {
    console.error("Authentication error:", error);

    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to access this resource",
      });
    }

    next();
  };
};

module.exports = {
  protect,
  authorize,
};

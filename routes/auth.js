const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();

const generateToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "7d",
    }
  );
};

// ===============================
// GET AUTHENTICATED USER
// ===============================
const getAuthenticatedUser = (req) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.split(" ")[1];

  try {
    return jwt.verify(
      token,
      process.env.JWT_SECRET
    );
  } catch {
    return null;
  }
};

// ===============================
// REGISTER
// ===============================
router.post("/register", async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role = "customer",
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message:
          "Name, email and password are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be at least 6 characters",
      });
    }

    if (!["customer", "seller"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid account type",
      });
    }

    const normalizedEmail =
      email.trim().toLowerCase();

    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          "An account with this email already exists",
      });
    }

    const hashedPassword =
      await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      INSERT INTO users
        (name, email, password, role)
      VALUES
        ($1, $2, $3, $4)
      RETURNING
        id,
        name,
        email,
        role,
        created_at
      `,
      [
        name.trim(),
        normalizedEmail,
        hashedPassword,
        role,
      ]
    );

    const user = result.rows[0];
    const token = generateToken(user);

    res.status(201).json({
      success: true,
      message: "Account created successfully",
      user,
      token,
    });
  } catch (error) {
    console.error("Register error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create account",
    });
  }
});

// ===============================
// LOGIN
// ===============================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message:
          "Email and password are required",
      });
    }

    const normalizedEmail =
      email.trim().toLowerCase();

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const user = result.rows[0];

    const passwordMatch =
      await bcrypt.compare(
        password,
        user.password
      );

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      created_at: user.created_at,
    };

    const token = generateToken(safeUser);

    res.json({
      success: true,
      message: "Login successful",
      user: safeUser,
      token,
    });
  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to login",
    });
  }
});

// ===============================
// SWITCH BUYER / SELLER
// ===============================
router.post("/switch-role", async (req, res) => {
  try {
    const authenticatedUser =
      getAuthenticatedUser(req);

    if (!authenticatedUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const currentRole =
      authenticatedUser.role;

    if (
      currentRole !== "customer" &&
      currentRole !== "seller"
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid current account type",
      });
    }

    const newRole =
      currentRole === "customer"
        ? "seller"
        : "customer";

    const result = await pool.query(
      `
      UPDATE users
      SET role = $1
      WHERE id = $2
      RETURNING
        id,
        name,
        email,
        role,
        created_at
      `,
      [
        newRole,
        authenticatedUser.id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User account not found",
      });
    }

    const user = result.rows[0];

    const token = generateToken(user);

    res.json({
      success: true,
      message:
        newRole === "seller"
          ? "Switched to seller mode"
          : "Switched to buyer mode",
      user,
      token,
    });
  } catch (error) {
    console.error(
      "Switch role error:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Failed to switch account type",
    });
  }
});

// ===============================
// BECOME A SELLER
// ===============================
// Kept for compatibility with existing frontend.
// Now requires authentication and can only
// convert the currently logged-in customer.
router.post("/become-seller", async (req, res) => {
  try {
    const authenticatedUser =
      getAuthenticatedUser(req);

    if (!authenticatedUser) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (
      authenticatedUser.role === "seller"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Account is already a seller",
      });
    }

    const result = await pool.query(
      `
      UPDATE users
      SET role = 'seller'
      WHERE id = $1
        AND role = 'customer'
      RETURNING
        id,
        name,
        email,
        role,
        created_at
      `,
      [authenticatedUser.id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          "Account could not be converted to seller",
      });
    }

    const user = result.rows[0];
    const token = generateToken(user);

    res.json({
      success: true,
      message:
        "Your account is now a seller account",
      user,
      token,
    });
  } catch (error) {
    console.error(
      "Become seller error:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Failed to convert account to seller",
    });
  }
});

module.exports = router;

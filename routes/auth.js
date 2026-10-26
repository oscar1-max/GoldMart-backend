
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const pool = require("../db");
const { sendGoldMartEmail } = require("../services/emailService");
const { rateLimitAuth } = require("../middleware/authRateLimit");

const router = express.Router();

const TOKEN_LIFETIME_MINUTES = 30;

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    created_at: user.created_at,
    email_verified_at: user.email_verified_at || null,
  };
}

function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  try {
    return jwt.verify(
      authHeader.slice(7),
      process.env.JWT_SECRET
    );
  } catch {
    return null;
  }
}

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function createVerificationToken() {
  const token = crypto.randomBytes(32).toString("hex");

  const hash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  return { token, hash };
}

function validVerificationToken(token) {
  return typeof token === "string" &&
    /^[a-f0-9]{64}$/.test(token);
}

function publicBackendUrl() {
  const value = String(
    process.env.GOLDMART_BACKEND_URL || ""
  ).trim().replace(/\/+$/, "");

  try {
    const url = new URL(value);

    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      )
    ) {
      return null;
    }

    if (url.username || url.password || url.search || url.hash) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function emailConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY &&
    process.env.GOLDMART_EMAIL_FROM &&
    publicBackendUrl()
  );
}

async function sendVerificationEmail(user, token) {
  const baseUrl = publicBackendUrl();

  if (!baseUrl) {
    return {
      sent: false,
      reason: "Public backend URL not configured",
    };
  }

  const verifyUrl =
    `${baseUrl}/api/auth/verify-email?token=` +
    encodeURIComponent(token);

  return sendGoldMartEmail({
    to: user.email,
    subject: "Verify your GoldMart email address",
    message:
      `Hello ${user.name || "there"},\n\n` +
      "Welcome to GoldMart!\n\n" +
      "Open the following link and select Confirm Email:\n\n" +
      `${verifyUrl}\n\n` +
      `This link expires in ${TOKEN_LIFETIME_MINUTES} minutes.\n\n` +
      "If you did not create this account, you can ignore this message.",
  });
}

function htmlPage(title, message, formAction = null) {
  const form = formAction
    ? `<form method="POST" action="${formAction}">
         <button type="submit">Confirm Email</button>
       </form>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport"
 content="width=device-width,initial-scale=1">
<title>GoldMart Email Verification</title>
</head>
<body style="font-family:Arial,sans-serif;
 max-width:520px;margin:60px auto;padding:20px">
<h2>GoldMart</h2>
<h3>${title}</h3>
<p>${message}</p>
${form}
</body>
</html>`;
}

function sendHtml(res, status, html) {
  return res
    .status(status)
    .set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; form-action 'self'; " +
        "style-src 'unsafe-inline'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
    })
    .type("html")
    .send(html);
}

// ==========================================
// REGISTER
// POST /api/auth/register
// ==========================================

router.post("/register", rateLimitAuth({ action: "register", ipLimit: 15, accountLimit: 6 }), async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role = "customer",
    } = req.body || {};

    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      !name.trim() ||
      !email.trim() ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    if (
      name.length > 150 ||
      email.length > 254 ||
      password.length > 1024
    ) {
      return res.status(400).json({
        success: false,
        message: "One or more fields are too long",
      });
    }

    if (!["customer", "seller"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid account type",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address",
      });
    }

    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (existingUser.rows.length) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const verification = createVerificationToken();

    const result = await pool.query(
      `
      INSERT INTO users (
        name,
        email,
        password,
        role,
        email_verification_token_hash,
        email_verification_expires_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        NOW() + INTERVAL '30 minutes'
      )
      RETURNING
        id,
        name,
        email,
        role,
        created_at,
        email_verified_at
      `,
      [
        name.trim(),
        normalizedEmail,
        passwordHash,
        role,
        verification.hash,
      ]
    );

    const user = result.rows[0];
    const token = generateToken(user);

    let emailSent = false;

    if (emailConfigured()) {
      const result = await sendVerificationEmail(
        user,
        verification.token
      );
      emailSent = result.sent === true;
    }

    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      user: safeUser(user),
      token,
      email_verification_required: true,
      email_verification_sent: emailSent,
      email_notice: emailSent
        ? "Check your email for a verification link."
        : "Verification email could not be sent yet. " +
          "You can request another link after email is configured.",
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists",
      });
    }

    console.error("Register error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to create account",
    });
  }
});

// ==========================================
// LOGIN
// POST /api/auth/login
// ==========================================

router.post("/login", rateLimitAuth({ action: "login", ipLimit: 45, accountLimit: 15 }), async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const user = result.rows[0];

    const passwordMatch = await bcrypt.compare(
      password,
      user.password
    );

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const publicUser = safeUser(user);

    return res.json({
      success: true,
      message: "Login successful",
      user: publicUser,
      token: generateToken(publicUser),
      email_verification_required:
        !Boolean(user.email_verified_at),
    });
  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to login",
    });
  }
});

// ==========================================
// REQUEST ANOTHER VERIFICATION EMAIL
// POST /api/auth/resend-verification
// Requires Authorization: Bearer token
// ==========================================

router.post("/resend-verification", rateLimitAuth({ action: "resend-verification", ipLimit: 15, accountLimit: 8 }), async (req, res) => {
  try {
    const authenticatedUser = getAuthenticatedUser(req);
    const userId = validId(authenticatedUser?.id);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Please sign in first",
      });
    }

    if (!emailConfigured()) {
      return res.status(503).json({
        success: false,
        message: "Email service is not ready yet",
      });
    }

    const verification = createVerificationToken();

    const result = await pool.query(
      `
      UPDATE users
      SET
        email_verification_token_hash = $1,
        email_verification_expires_at =
          NOW() + INTERVAL '30 minutes'
      WHERE id = $2
        AND email_verified_at IS NULL
        AND (
          email_verification_expires_at IS NULL
          OR email_verification_expires_at <=
            NOW() + INTERVAL '29 minutes'
        )
      RETURNING id, name, email
      `,
      [verification.hash, userId]
    );

    if (!result.rows.length) {
      const userResult = await pool.query(
        `
        SELECT email_verified_at
        FROM users
        WHERE id = $1
        `,
        [userId]
      );

      if (!userResult.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Account not found",
        });
      }

      if (userResult.rows[0].email_verified_at) {
        return res.json({
          success: true,
          message: "Your email is already verified",
        });
      }

      return res.status(429).json({
        success: false,
        message:
          "Please wait one minute before requesting another link",
      });
    }

    const sent = await sendVerificationEmail(
      result.rows[0],
      verification.token
    );

    if (!sent.sent) {
      return res.status(503).json({
        success: false,
        message:
          "Email could not be sent. Please try again later.",
      });
    }

    return res.json({
      success: true,
      message: "Verification email sent successfully",
    });
  } catch (error) {
    console.error(
      "Resend verification error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Unable to request verification",
    });
  }
});

// ==========================================
// SHOW EMAIL CONFIRMATION PAGE
// GET /api/auth/verify-email?token=...
// ==========================================

router.get("/verify-email", (req, res) => {
  const token = req.query?.token;

  if (!validVerificationToken(token)) {
    return sendHtml(
      res,
      400,
      htmlPage(
        "Invalid link",
        "This verification link is not valid."
      )
    );
  }

  const action =
    "/api/auth/verify-email/confirm?token=" +
    encodeURIComponent(token);

  return sendHtml(
    res,
    200,
    htmlPage(
      "Confirm your email",
      "Select the button below to verify your GoldMart email address.",
      action
    )
  );
});

// ==========================================
// CONFIRM EMAIL
// POST /api/auth/verify-email/confirm
// ==========================================

router.post("/verify-email/confirm", async (req, res) => {
  try {
    const token = req.query?.token;

    if (!validVerificationToken(token)) {
      return sendHtml(
        res,
        400,
        htmlPage(
          "Invalid link",
          "This verification link is not valid."
        )
      );
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const result = await pool.query(
      `
      UPDATE users
      SET
        email_verified_at = NOW(),
        email_verification_token_hash = NULL,
        email_verification_expires_at = NULL
      WHERE email_verification_token_hash = $1
        AND email_verification_expires_at > NOW()
        AND email_verified_at IS NULL
      RETURNING id
      `,
      [tokenHash]
    );

    if (!result.rows.length) {
      return sendHtml(
        res,
        400,
        htmlPage(
          "Link expired or already used",
          "Please sign in to GoldMart and request a new verification email if needed."
        )
      );
    }

    return sendHtml(
      res,
      200,
      htmlPage(
        "Email verified successfully!",
        "Your GoldMart email address is now verified. You can return to GoldMart and sign in."
      )
    );
  } catch (error) {
    console.error(
      "Verify email error:",
      error.message
    );

    return sendHtml(
      res,
      500,
      htmlPage(
        "Verification unavailable",
        "Please try again later."
      )
    );
  }
});

// ==========================================
// SWITCH BUYER / SELLER
// POST /api/auth/switch-role
// ==========================================

router.post("/switch-role", async (req, res) => {
  try {
    const authenticatedUser = getAuthenticatedUser(req);
    const userId = validId(authenticatedUser?.id);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const result = await pool.query(
      `
      UPDATE users
      SET role = CASE
        WHEN role = 'customer' THEN 'seller'
        WHEN role = 'seller' THEN 'customer'
      END
      WHERE id = $1
        AND role IN ('customer', 'seller')
      RETURNING
        id,
        name,
        email,
        role,
        created_at,
        email_verified_at
      `,
      [userId]
    );

    if (!result.rows.length) {
      return res.status(400).json({
        success: false,
        message: "Account cannot switch roles",
      });
    }

    const user = safeUser(result.rows[0]);

    return res.json({
      success: true,
      message:
        user.role === "seller"
          ? "Switched to seller mode"
          : "Switched to buyer mode",
      user,
      token: generateToken(user),
    });
  } catch (error) {
    console.error("Switch role error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to switch account type",
    });
  }
});

// ==========================================
// BECOME A SELLER
// POST /api/auth/become-seller
// ==========================================

router.post("/become-seller", async (req, res) => {
  try {
    const authenticatedUser = getAuthenticatedUser(req);
    const userId = validId(authenticatedUser?.id);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
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
        created_at,
        email_verified_at
      `,
      [userId]
    );

    if (!result.rows.length) {
      return res.status(400).json({
        success: false,
        message:
          "Account is already a seller or cannot be converted",
      });
    }

    const user = safeUser(result.rows[0]);

    return res.json({
      success: true,
      message: "Your account is now a seller account",
      user,
      token: generateToken(user),
    });
  } catch (error) {
    console.error(
      "Become seller error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Failed to convert account to seller",
    });
  }
});

module.exports = router;

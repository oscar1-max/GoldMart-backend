const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();

function getToken(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.split(" ")[1];
}

async function getAuthenticatedUser(req) {
  const token = getToken(req);

  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query(
      `SELECT id, name, email, role, is_banned
       FROM users
       WHERE id = $1`,
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  } catch (error) {
    return null;
  }
}

function isAdmin(user) {
  if (!user) return false;

  const adminIds = (process.env.ADMIN_USER_ID || "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter(Boolean);

  return adminIds.includes(Number(user.id));
}

/*
  POST /api/reports

  Any logged-in user can report another user.

  Customer -> Seller
  Seller   -> Customer
*/
router.post("/", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (user.is_banned) {
      return res.status(403).json({
        success: false,
        message: "Your account is banned",
      });
    }

    const { reportedUserId, reason, message } = req.body;

    const targetId = Number(reportedUserId);

    if (!targetId || !reason) {
      return res.status(400).json({
        success: false,
        message: "reportedUserId and reason are required",
      });
    }

    if (targetId === Number(user.id)) {
      return res.status(400).json({
        success: false,
        message: "You cannot report yourself",
      });
    }

    const targetResult = await pool.query(
      `SELECT id, name, email, role
       FROM users
       WHERE id = $1`,
      [targetId]
    );

    if (targetResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Reported user not found",
      });
    }

    const target = targetResult.rows[0];

    // Customer can report seller.
    if (user.role === "customer" && target.role !== "seller") {
      return res.status(400).json({
        success: false,
        message: "A buyer can only report a seller",
      });
    }

    // Seller can report customer.
    if (user.role === "seller" && target.role !== "customer") {
      return res.status(400).json({
        success: false,
        message: "A seller can only report a buyer",
      });
    }

    const reportResult = await pool.query(
      `INSERT INTO reports
        (reporter_id, reported_user_id, reason, message)
       VALUES ($1, $2, $3, $4)
       RETURNING id, reporter_id, reported_user_id,
                 reason, message, status, created_at`,
      [
        user.id,
        target.id,
        String(reason).trim(),
        message ? String(message).trim() : null,
      ]
    );

    const report = reportResult.rows[0];

    // Notify both admins.
    const adminIds = (process.env.ADMIN_USER_ID || "")
      .split(",")
      .map((id) => Number(id.trim()))
      .filter(Boolean);

    for (const adminId of adminIds) {
      await pool.query(
        `INSERT INTO notifications
          (user_id, title, message, type)
         VALUES ($1, $2, $3, $4)`,
        [
          adminId,
          "New User Report",
          `${user.name} reported ${target.name}. Reason: ${reason}`,
          "report",
        ]
      );
    }

    return res.status(201).json({
      success: true,
      message: "Report submitted successfully",
      report,
    });
  } catch (error) {
    console.error("Create report error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to submit report",
    });
  }
});

/*
  GET /api/reports

  ADMIN ONLY
*/
router.get("/", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!isAdmin(user)) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    const result = await pool.query(`
      SELECT
        r.id,
        r.reason,
        r.message,
        r.status,
        r.admin_message,
        r.created_at,
        r.updated_at,

        reporter.id AS reporter_id,
        reporter.name AS reporter_name,
        reporter.role AS reporter_role,

        reported.id AS reported_user_id,
        reported.name AS reported_user_name,
        reported.role AS reported_user_role,
        reported.is_banned AS reported_user_is_banned

      FROM reports r

      JOIN users reporter
        ON reporter.id = r.reporter_id

      JOIN users reported
        ON reported.id = r.reported_user_id

      ORDER BY r.created_at DESC
    `);

    return res.json({
      success: true,
      reports: result.rows,
    });
  } catch (error) {
    console.error("Get reports error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load reports",
    });
  }
});

/*
  PATCH /api/reports/:id

  ADMIN ONLY

  Update report status and admin message.
*/
router.patch("/:id", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!isAdmin(user)) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    const reportId = Number(req.params.id);

    const { status, adminMessage } = req.body;

    const allowedStatuses = [
      "pending",
      "reviewed",
      "resolved",
      "dismissed",
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid report status",
      });
    }

    const result = await pool.query(
      `UPDATE reports
       SET
         status = $1,
         admin_message = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [
        status,
        adminMessage ? String(adminMessage).trim() : null,
        reportId,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Report not found",
      });
    }

    return res.json({
      success: true,
      message: "Report updated successfully",
      report: result.rows[0],
    });
  } catch (error) {
    console.error("Update report error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update report",
    });
  }
});

/*
  POST /api/reports/users/:id/ban

  ADMIN ONLY
*/
router.post("/users/:id/ban", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!isAdmin(user)) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    const targetId = Number(req.params.id);

    if (!targetId) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    // Admins cannot ban another admin.
    if (isAdmin({ id: targetId })) {
      return res.status(403).json({
        success: false,
        message: "Administrators cannot be banned",
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET is_banned = TRUE
       WHERE id = $1
       RETURNING id, name, email, role, is_banned`,
      [targetId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.json({
      success: true,
      message: "User has been banned",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Ban user error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to ban user",
    });
  }
});

/*
  POST /api/reports/users/:id/unban

  ADMIN ONLY
*/
router.post("/users/:id/unban", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (!isAdmin(user)) {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    const targetId = Number(req.params.id);

    if (!targetId) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET is_banned = FALSE
       WHERE id = $1
       RETURNING id, name, email, role, is_banned`,
      [targetId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.json({
      success: true,
      message: "User has been unbanned",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Unban user error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to unban user",
    });
  }
});

module.exports = router;

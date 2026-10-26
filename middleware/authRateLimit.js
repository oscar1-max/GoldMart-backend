"use strict";

// Lightweight, bounded single-instance protection for auth endpoints.
// For horizontally scaled deployment, replace with a shared Redis-backed limiter.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_KEYS = 15000;
const buckets = new Map();

function now() { return Date.now(); }
function cleanup(time) {
  for (const [key, record] of buckets) {
    if (record.resetAt <= time) buckets.delete(key);
  }
  while (buckets.size >= MAX_KEYS) buckets.delete(buckets.keys().next().value);
}
function check(key, limit, time = now()) {
  let record = buckets.get(key);
  if (!record || record.resetAt <= time) {
    if (buckets.size >= MAX_KEYS) cleanup(time);
    record = { count: 0, resetAt: time + WINDOW_MS };
    buckets.set(key, record);
  }
  record.count += 1;
  return { allowed: record.count <= limit, retryAfter: Math.max(1, Math.ceil((record.resetAt - time) / 1000)) };
}
function ipOf(req) { return String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 128); }
function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 254) : "";
}
function rateLimitAuth({ action, ipLimit = 30, accountLimit = 12 }) {
  return (req, res, next) => {
    const time = now();
    const ip = ipOf(req);
    const ipResult = check(`${action}:ip:${ip}`, ipLimit, time);
    const email = normalizeEmail(req.body?.email);
    const accountResult = email ? check(`${action}:email:${email}`, accountLimit, time) : { allowed: true, retryAfter: 0 };
    if (!ipResult.allowed || !accountResult.allowed) {
      res.set("Retry-After", String(Math.max(ipResult.retryAfter, accountResult.retryAfter)));
      return res.status(429).json({ success: false, message: "Too many attempts. Please try again later." });
    }
    next();
  };
}
module.exports = { rateLimitAuth, check, WINDOW_MS };

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { check, WINDOW_MS } = require("../middleware/authRateLimit");

test("requests under the limit are accepted", () => {
  const start = 100000;
  assert.equal(check("auth-test-allow", 2, start).allowed, true);
  assert.equal(check("auth-test-allow", 2, start + 1).allowed, true);
});
test("limit blocks repeated attempts with retry time", () => {
  const start = 200000;
  assert.equal(check("auth-test-block", 1, start).allowed, true);
  const result = check("auth-test-block", 1, start + 1);
  assert.equal(result.allowed, false);
  assert.ok(result.retryAfter > 0);
});
test("window expires and resets", () => {
  const start = 300000;
  check("auth-test-reset", 1, start);
  assert.equal(check("auth-test-reset", 1, start + 1).allowed, false);
  assert.equal(check("auth-test-reset", 1, start + WINDOW_MS).allowed, true);
});

require("dotenv").config();

const express = require("express");
const path = require("path");
const bcrypt = require("bcrypt");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();

// Render and similar hosts usually sit behind a proxy.
// This helps req.ip work correctly for lockouts/rate limiting.
app.set("trust proxy", 1);

app.use(helmet());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PASSWORD_VALUE = process.env.PASSWORD_VALUE || "";
const GROUP_CODE_HASH = process.env.GROUP_CODE_HASH || "";

const MAX_STRIKES = 3;
const LOCK_TIME_MS = 7.5 * 60 * 1000; // 7.5 minutes
const ipAttempts = new Map();

// General rate limit for the password endpoint
const passwordLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many attempts. Try again later."
  }
});

function getState(ip) {
  if (!ipAttempts.has(ip)) {
    ipAttempts.set(ip, { strikes: 0, lockedUntil: 0 });
  }
  return ipAttempts.get(ip);
}

function now() {
  return Date.now();
}

function remainingMs(lockedUntil) {
  return Math.max(0, lockedUntil - now());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Explicit root route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/api/password", passwordLimiter, async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const state = getState(ip);

  if (state.lockedUntil > now()) {
    return res.status(429).json({
      error: "Locked out after 3 failed attempts.",
      retry_after_ms: remainingMs(state.lockedUntil)
    });
  }

  const { agreed, confirmed, group_code } = req.body || {};

  if (!agreed || !confirmed) {
    return res.status(403).json({ error: "Agreement not confirmed." });
  }

  if (!GROUP_CODE_HASH) {
    return res.status(500).json({ error: "Group code hash not configured." });
  }

  if (!PASSWORD_VALUE) {
    return res.status(500).json({ error: "Password not configured." });
  }

  if (typeof group_code !== "string" || !group_code.trim()) {
    return res.status(401).json({ error: "Group code required." });
  }

  const valid = await bcrypt.compare(group_code.trim(), GROUP_CODE_HASH);

  if (!valid) {
    state.strikes += 1;
    await sleep(650);

    if (state.strikes >= MAX_STRIKES) {
      state.lockedUntil = now() + LOCK_TIME_MS;
      return res.status(429).json({
        error: "3 failed attempts. Locked for 7.5 minutes.",
        retry_after_ms: LOCK_TIME_MS
      });
    }

    return res.status(401).json({
      error: `Invalid group code. Strike ${state.strikes}/${MAX_STRIKES}.`,
      strikes: state.strikes,
      strikes_max: MAX_STRIKES
    });
  }

  // Success resets the strike count and lockout.
  state.strikes = 0;
  state.lockedUntil = 0;

  return res.json({
    label: "The password is this:",
    password: PASSWORD_VALUE
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
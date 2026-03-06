require("dotenv").config();

const express = require("express");
const path = require("path");
const bcrypt = require("bcrypt");
//const helmet = require("helmet");
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

});const agree = document.getElementById("agree");
const confirmBtn = document.getElementById("confirmBtn");
const resetBtn = document.getElementById("resetBtn");

const groupCode = document.getElementById("groupCode");
const requestBtn = document.getElementById("requestBtn");
const revealBtn = document.getElementById("revealBtn");

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const lockPill = document.getElementById("lockPill");

const toast = document.getElementById("toast");
const logEl = document.getElementById("log");

let confirmed = false;
let accessGranted = false;
let revealed = false;
let fetchedPassword = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function showToast(msg, bad = false) {
  toast.textContent = msg;
  toast.classList.toggle("bad", bad);
  toast.style.display = "block";
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (toast.style.display = "none"), 2600);
}

function setStatus(mode) {
  dot.classList.remove("ok", "bad");

  if (mode === "locked") {
    dot.style.background = "var(--warn)";
    statusText.textContent = "LOCKED";
    lockPill.textContent = "🔒 LOCKED";
  } else if (mode === "confirmed") {
    dot.classList.add("ok");
    statusText.textContent = "CONFIRMED";
    lockPill.textContent = "🧾 CONFIRMED";
  } else if (mode === "granted") {
    dot.classList.add("ok");
    statusText.textContent = "ACCESS GRANTED";
    lockPill.textContent = "✅ ACCESS GRANTED";
  } else if (mode === "denied") {
    dot.classList.add("bad");
    statusText.textContent = "ACCESS DENIED";
    lockPill.textContent = "⛔ ACCESS DENIED";
  }
}

async function typeLine(line, delay = 12) {
  for (let i = 0; i < line.length; i++) {
    logEl.textContent += line[i];
    await sleep(delay);
  }
  logEl.textContent += "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

async function bootLog() {
  logEl.textContent = "";
  await typeLine("ACTON CIV PROJECT SECURITY TERMINAL v1.0");
  await typeLine("--------------------------------------");
  await typeLine("SYSTEM CHECK: OK");
  await typeLine("NETWORK LINK: OK");
  await typeLine("AUTH MODULE: STANDBY");
  await typeLine("");
  await typeLine("AWAITING OPERATOR CONFIRMATION...");
}

function lockAll() {
  confirmed = false;
  accessGranted = false;
  revealed = false;
  fetchedPassword = null;

  confirmBtn.disabled = !agree.checked;
  groupCode.disabled = true;
  groupCode.value = "";

  requestBtn.disabled = true;
  revealBtn.disabled = true;

  setStatus("locked");
}

function setConfirmed() {
  confirmed = true;
  accessGranted = false;
  revealed = false;
  fetchedPassword = null;

  groupCode.disabled = false;
  requestBtn.disabled = false;
  revealBtn.disabled = true;

  setStatus("confirmed");
}

async function fetchPasswordFromServer(code) {
  const res = await fetch("/api/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agreed: true, confirmed: true, group_code: code })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || "Request failed.");
    e.retry_after_ms = data.retry_after_ms;
    throw e;
  }
  return data;
}

async function accessSequence() {
  const code = groupCode.value.trim();
  if (!code) {
    showToast("ENTER GROUP CODE.", true);
    groupCode.focus();
    return;
  }

  requestBtn.disabled = true;
  confirmBtn.disabled = true;
  groupCode.disabled = true;

  await typeLine("");
  await typeLine(">> REQUESTING ACCESS TOKEN...");
  await typeLine(">> VALIDATING GROUP CODE...");

  try {
    const result = await fetchPasswordFromServer(code);
    fetchedPassword = result;
    accessGranted = true;
    setStatus("granted");

    await typeLine(">> CODE ACCEPTED.");
    await typeLine(">> CLEARANCE VERIFIED: ACTON GROUP");
    await typeLine(">> SECURE PAYLOAD READY.");
    await typeLine("");
    await typeLine("TYPE: REVEAL / HIDE to display password.");

    revealBtn.disabled = false;
    showToast("ACCESS GRANTED. PAYLOAD READY.");
  } catch (err) {
    accessGranted = false;
    setStatus("denied");

    await typeLine(">> CODE REJECTED.");
    await typeLine(">> ACCESS DENIED.");
    await typeLine(`>> REASON: ${err.message}`);

    if (err.retry_after_ms) {
      const secs = Math.ceil(err.retry_after_ms / 1000);
      const mins = Math.floor(secs / 60);
      const rem = secs % 60;
      await typeLine(`>> COOLDOWN: ${mins}m ${rem}s`);
    }

    await typeLine("");

    groupCode.disabled = false;
    requestBtn.disabled = false;
    confirmBtn.disabled = false;

    showToast(err.message, true);
  }
}

async function toggleReveal() {
  if (!accessGranted || !fetchedPassword) return;

  if (!revealed) {
    await typeLine("");
    await typeLine(">> DECRYPTING PAYLOAD...");
    await typeLine(">> DISPLAYING PASSWORD:");
    await typeLine(`   ${fetchedPassword.label} ${fetchedPassword.password}`, 6);
    revealed = true;
    showToast("PASSWORD REVEALED.");
  } else {
    await typeLine("");
    await typeLine(">> REDACTING PAYLOAD...");
    await typeLine(">> PASSWORD HIDDEN.");
    revealed = false;
    showToast("PASSWORD HIDDEN.");
  }
}

agree.addEventListener("change", async () => {
  confirmBtn.disabled = !agree.checked;

  if (!agree.checked && confirmed) {
    lockAll();
    await typeLine("");
    await typeLine(">> OPERATOR UNCONFIRMED AGREEMENT.");
    await typeLine(">> SYSTEM RETURNED TO LOCKED STATE.");
    showToast("RE-LOCKED.", true);
  }
});

confirmBtn.addEventListener("click", async () => {
  if (!agree.checked) return;

  setConfirmed();
  await typeLine("");
  await typeLine(">> OPERATOR CONFIRMED AGREEMENT.");
  await typeLine(">> GROUP CODE REQUIRED FOR ACCESS.");
  groupCode.focus();
  showToast("CONFIRMED. ENTER GROUP CODE.");
});

requestBtn.addEventListener("click", accessSequence);
revealBtn.addEventListener("click", toggleReveal);

groupCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !requestBtn.disabled) {
    requestBtn.click();
  }
});

resetBtn.addEventListener("click", async () => {
  agree.checked = false;
  lockAll();
  await bootLog();
  showToast("RESET COMPLETE.");
});

(async () => {
  setStatus("locked");
  confirmBtn.disabled = true;
  groupCode.disabled = true;
  requestBtn.disabled = true;
  revealBtn.disabled = true;
  await bootLog();
})();

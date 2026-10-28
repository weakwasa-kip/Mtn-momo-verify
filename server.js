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
  if (!BOT_TOKEN) {
    throw new Error("Telegram bot token is not configured.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || "Telegram request failed."
    );
  }

  return result.result;
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "Demo server is running."
  });
});

// Create demo session
app.post("/api/session", (req, res) => {
  const sessionId = crypto.randomBytes(12).toString("hex");

  sessions.set(sessionId, {
    createdAt: Date.now(),
    stage: null,
    status: "idle"
  });

  res.json({
    sessionId
  });
});

// Request Telegram approval
app.post("/api/approval-request", async (req, res) => {
  const { sessionId, stage } = req.body || {};

  const allowedStages = ["pin", "code1", "code2"];
  const session = sessions.get(sessionId);

  if (!session || !allowedStages.includes(stage)) {
    return res.status(400).json({
      error: "Invalid demo session or stage."
    });
  }

  if (Date.now() - session.createdAt > 30 * 60 * 1000) {
    sessions.delete(sessionId);

    return res.status(410).json({
      error: "Demo session expired. Please restart."
    });
  }

  if (!CHAT_ID || !BOT_TOKEN) {
    return res.status(503).json({
      error: "Telegram environment variables are missing."
    });
  }

  session.stage = stage;
  session.status = "pending";
  session.updatedAt = Date.now();

  const stageNames = {
    pin: "Demo PIN stage",
    code1: "Demo code stage 1",
    code2: "Demo code stage 2"
  };

  try {
    await telegram("sendMessage", {
      chat_id: CHAT_ID,

      text:
        "DEMO APPROVAL REQUEST\n\n" +
        "Stage: " + stageNames[stage] + "\n" +
        "Session: " + sessionId + "\n\n" +
        "No PIN or OTP values are collected or transmitted.",

      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Approve",
              callback_data: `approve:${sessionId}:${stage}`
            },
            {
              text: "Decline",
              callback_data: `decline:${sessionId}:${stage}`
            }
          ]
        ]
      }
    });

    res.json({
      ok: true,
      status: "pending"
    });

  } catch (error) {
    session.status = "idle";

    res.status(502).json({
      error: "Telegram notification failed."
    });
  }
});

// Check demo approval status
app.get("/api/status", (req, res) => {
  const { sessionId, stage } = req.query;

  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      error: "Demo session not found."
    });
  }

  if (session.stage !== stage) {
    return res.json({
      status: "idle"
    });
  }

  res.json({
    status: session.status
  });
});

// Receive Telegram inline-button clicks
app.post("/telegram-webhook", async (req, res) => {
  res.sendStatus(200);

  const query = req.body?.callback_query;

  if (!query?.data) return;

  const match = /^(approve|decline):([a-f0-9]+):(pin|code1|code2)$/
    .exec(query.data);

  if (!match) return;

  const [, decision, sessionId, stage] = match;

  const session = sessions.get(sessionId);

  if (
    !session ||
    session.stage !== stage ||
    session.status !== "pending"
  ) {
    try {
      await telegram("answerCallbackQuery", {
        callback_query_id: query.id,
        text: "This demo request is no longer active."
      });
    } catch (_) {}

    return;
  }

  session.status =
    decision === "approve" ? "approved" : "declined";

  session.updatedAt = Date.now();

  try {
    await telegram("answerCallbackQuery", {
      callback_query_id: query.id,
      text: decision === "approve"
        ? "Demo approved."
        : "Demo declined."
    });

    await telegram("editMessageReplyMarkup", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: {
        inline_keyboard: []
      }
    });

  } catch (error) {
    console.error("Telegram callback update failed.");
  }
});

// Remove expired demo sessions
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;

  for (const [id, session] of sessions.entries()) {
    if (session.createdAt < cutoff) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

// Serve the demo
app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.listen(PORT, () => {
  console.log(`Demo server running on port ${PORT}`);
});

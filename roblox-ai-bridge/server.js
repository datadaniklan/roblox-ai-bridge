import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const OPENAI_KEY = process.env.OPENAI_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

app.get("/", (req, res) => {
  res.send("OK - Roblox AI Bridge is running ✅");
});

app.get("/roblox-ai", (req, res) => {
  res.send("OK - /roblox-ai is ready ✅ (use POST)");
});

app.post("/roblox-ai", async (req, res) => {
  try {
    if (!OPENAI_KEY) {
      return res.status(500).json({ reply: "Server missing OPENAI_KEY 😭" });
    }

    const { username, message } = req.body || {};
    if (typeof message !== "string" || message.trim().length === 0) {
      return res.json({ reply: "Type something first 😅" });
    }

    const safeUser = String(username || "Player").slice(0, 30);
    const safeMsg = String(message).slice(0, 300);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "You are a fun, friendly, safe Roblox AI. Keep replies short." },
          { role: "user", content: `${safeUser}: ${safeMsg}` },
        ],
        max_tokens: 120,
      }),
    });

    const text = await response.text(); // read raw body first
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!response.ok) {
      const errMsg =
        (data && (data.error?.message || data.error)) ||
        text ||
        "Unknown OpenAI error";
      console.log("[OPENAI ERROR]", response.status, errMsg);
      return res.json({
        reply: `OpenAI error ${response.status}: ${String(errMsg).slice(0, 180)} 😭`,
      });
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      console.log("[OPENAI] No choices in response:", text);
      return res.json({ reply: "No reply from OpenAI (empty response) 😭" });
    }

    return res.json({ reply });
  } catch (e) {
    console.log("[SERVER ERROR]", e);
    return res.json({ reply: "Bridge server error 😭" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Bridge running on port", port));

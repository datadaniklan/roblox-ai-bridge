import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const OPENAI_KEY = process.env.OPENAI_KEY;
const MODEL = "gpt-4.1-mini";

// log all requests
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// root check
app.get("/", (req, res) => {
  res.send("OK - Roblox AI Bridge is running ✅");
});

// ✅ THIS is what your browser test was missing
app.get("/roblox-ai", (req, res) => {
  res.send("OK - /roblox-ai is ready ✅ (POST only)");
});

app.post("/roblox-ai", async (req, res) => {
  try {
    if (!OPENAI_KEY) {
      console.log("[CONFIG] OPENAI_KEY missing");
      return res.json({ reply: "Server missing OPENAI_KEY 😭" });
    }

    const { username, message } = req.body || {};
    if (typeof message !== "string" || message.trim() === "") {
      return res.json({ reply: "Say something first 😅" });
    }

    const safeUser = String(username || "Player").slice(0, 30);
    const safeMsg = String(message).slice(0, 300);

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: "You are a friendly Roblox AI. Keep replies short." },
            { role: "user", content: `${safeUser}: ${safeMsg}` },
          ],
          max_tokens: 120,
        }),
      }
    );

    const raw = await response.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}

    if (!response.ok) {
      const errMsg = data?.error?.message || raw || "Unknown OpenAI error";
      console.log("[OPENAI ERROR]", response.status, errMsg);
      return res.json({
        reply: `OpenAI error ${response.status}: ${String(errMsg).slice(0, 150)} 😭`,
      });
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      console.log("[OPENAI] Empty reply:", raw);
      return res.json({ reply: "OpenAI gave empty reply 😭" });
    }

    return res.json({ reply });
  } catch (e) {
    console.log("[SERVER ERROR]", e);
    return res.json({ reply: "Bridge crashed 😭" });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Bridge running on port", port));

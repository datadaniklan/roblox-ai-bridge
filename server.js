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

// browser test
app.get("/roblox-ai", (req, res) => {
  res.send("OK - /roblox-ai is ready ✅ (POST only)");
});

// ✅ mode -> system prompt
function systemPromptForMode(mode) {
  const m = String(mode || "helper").toLowerCase();

  if (m === "builder") {
    return "You are a friendly, helpful AI inside a Roblox game. Focus on Roblox Studio + Lua scripting help. Give clear step-by-step fixes. Keep replies short but useful.";
  }
  if (m === "funny") {
    return "You are a friendly, helpful AI inside a Roblox game. Be funny and playful, but still helpful. No rude or unsafe content. Keep replies short.";
  }
  if (m === "strict") {
    return "You are a friendly, helpful AI inside a Roblox game. Be extremely concise: 1-3 short sentences, or short bullet points. No extra chatter.";
  }
  // helper default
  return "You are a friendly, helpful AI inside a Roblox game. You want to help players with anything they ask. Keep replies short.";
}

app.post("/roblox-ai", async (req, res) => {
  try {
    if (!OPENAI_KEY) {
      console.log("[CONFIG] OPENAI_KEY missing");
      return res.json({ reply: "Server missing OPENAI_KEY 😭" });
    }

    // ✅ includes history + mode
    const { username, message, history, mode } = req.body || {};
    if (typeof message !== "string" || message.trim() === "") {
      return res.json({ reply: "Say something first 😅" });
    }

    const safeUser = String(username || "Player").slice(0, 30);
    const safeMsg = String(message || "").slice(0, 300);

    // Use history if provided, but limit it
    const hist = Array.isArray(history) ? history.slice(-40) : [];

    const messages = [
      {
        role: "system",
        content: systemPromptForMode(mode),
      },
      ...hist.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "").slice(0, 300),
      })),
      { role: "user", content: `${safeUser}: ${safeMsg}` },
    ];

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: 160, // a tiny bit more so it doesn't cut off mid-sentence
      }),
    });

    const raw = await response.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {}

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

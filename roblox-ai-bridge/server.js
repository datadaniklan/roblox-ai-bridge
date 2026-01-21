import express from "express";

const app = express();
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_KEY;

// ✅ Health check (so you can open the link and see it's alive)
app.get("/", (req, res) => {
  res.send("OK - Roblox AI Bridge is running ✅");
});

app.post("/roblox-ai", async (req, res) => {
  try {
    if (!OPENAI_KEY) return res.json({ reply: "Server missing OPENAI_KEY 😭" });

    const { username, message } = req.body || {};
    if (typeof message !== "string" || message.length === 0) {
      return res.json({ reply: "Say something first 😅" });
    }

    const safeMessage = message.slice(0, 300);
    const safeUser = (username || "Player").slice(0, 30);

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You are a fun, friendly, safe AI inside a Roblox game. Keep replies short." },
          { role: "user", content: `${safeUser}: ${safeMessage}` }
        ],
        max_tokens: 120
      })
    });

    const j = await r.json();
    const reply = j?.choices?.[0]?.message?.content?.trim();

    if (!reply) return res.json({ reply: "No reply (API error) 😭" });

    res.json({ reply });
  } catch (e) {
    res.json({ reply: "Bridge server error 😭" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Bridge running on port", port));

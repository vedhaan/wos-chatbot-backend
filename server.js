const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Groq = require("groq-sdk");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ── Groq Setup ────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `
You are a helpful shopping assistant for "World of Sugandh", a clothing brand.

Your job:
- Help customers find the right products, sizes, and styles
- Answer questions about orders, shipping, and returns
- Keep responses short, friendly, and on-brand
- If you don't know something specific (like live stock), politely say so and suggest they contact support
- Never make up product details or prices
- Stay strictly on topic — clothing, fashion, the brand only
`;

// ── Middleware ────────────────────────────────────────────
app.use(cors({
  origin: 'https://their-shopify-store.myshopify.com'
}));
app.use(express.json());

// ── Chat History Store (in-memory, per session) ───────────
const sessions = new Map();

// ── Routes ────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "World of Sugandh chatbot is running" });
});

// Main chat endpoint
app.post("/chat", async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "Message is required." });
  }

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required." });
  }

  try {
    // Get or create session history
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, []);
    }

    const history = sessions.get(sessionId);

    // Build messages array with system prompt + history + new message
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: message.trim() },
    ];

    // Call Groq
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages,
      max_tokens: 500,
      temperature: 0.7,
    });

    const responseText = completion.choices[0].message.content;

    // Update history
    history.push({ role: "user", content: message.trim() });
    history.push({ role: "assistant", content: responseText });

    // Cap history to last 20 exchanges
    if (history.length > 40) {
      history.splice(0, 2);
    }

    res.json({ reply: responseText });

  } catch (error) {
    console.error("Groq API error:", error.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ── Start Server ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Load store data ───────────────────────────────────────
function loadStoreData() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "data.json"), "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("Failed to load data.json:", e.message);
    return null;
  }
}

function buildSystemPrompt(data) {
  if (!data || !Array.isArray(data.collections) || !Array.isArray(data.products)) {
    console.error("data.json malformed. Keys found:", data ? Object.keys(data) : "data is null");
    return `You are a helpful shopping assistant for "World of Sugandh"...`;
  }
  // if (!data) {
  //   return `You are a helpful shopping assistant for "World of Sugandh", a clothing brand. 
  //   Answer general questions about fashion and clothing. 
  //   If asked about specific products, say you don't have that information right now and suggest contacting support.`;
  // }

  const { store, collections, products } = data;

  // Build readable collections list
  const collectionList = collections
    .map(c => `- ${c.name} (id: ${c.id})`)
    .join("\n");

  // Build readable product list
  const productList = products.map(p => {
    const cols = p.collections
      .map(cid => collections.find(c => c.id === cid)?.name || cid)
      .join(", ");

    const sizes = p.sizes_available.join(", ");

    const discount = p.discount_percent
      ? ` (${p.discount_percent}% off, original Rs. ${p.original_price})`
      : "";

    const measurements = p.measurements
      ? Object.entries(p.measurements)
          .map(([size, m]) =>
            `    ${size}: Bust ${m.bust}", Waist ${m.top_waist}", Shoulder ${m.shoulder}", Length ${m.top_length}", Sleeve ${m.sleeve_length}"`
          )
          .join("\n")
      : "Not available";

    return `
Product: ${p.name}
  SKU: ${p.id}
  Collections: ${cols}
  Price: Rs. ${p.price}${discount}
  In Stock: ${p.in_stock ? "Yes" : "No"}
  Ready to Ship: ${p.ready_to_ship ? "Yes" : `No, ships in ${p.shipping_days} days`}
  Sizes: ${sizes}
  Color: ${p.details.color}
  Fit: ${p.details.fit}
  Neckline: ${p.details.neckline}
  Fabric: Top - ${p.fabric.top}, Bottom - ${p.fabric.bottom}
  Washcare: ${p.fabric.washcare}
  Components: ${p.details.number_of_components}
  Description: ${p.details.description}
  Measurements (in inches):
${measurements}
  URL: ${p.url}`;
  }).join("\n---");

  return `
You are a helpful and knowledgeable shopping assistant for "World of Sugandh", an Indian women's clothing brand.

STORE INFO:
- Email: ${store.email}
- WhatsApp: ${store.whatsapp}
- Address: ${store.address}
- Shipping: ${store.shipping_policy}
- Returns: ${store.return_policy}
- Payment Options: ${store.payment_options.join(", ")}

COLLECTIONS:
${collectionList}

PRODUCTS:
${productList}

YOUR RULES:
- Answer only based on the product data above. Never make up prices, sizes, or availability.
- If a customer asks for a size not listed, tell them it's not available.
- When recommending products, mention the price, collections it belongs to, and the URL.
- For size help, use the measurements provided. Ask the customer their bust/waist if they're unsure.
- Keep responses short, warm, and helpful.
- If asked something you don't know, direct them to WhatsApp: ${store.whatsapp} or email: ${store.email}.
- Never discuss anything outside of clothing, fashion, and this brand.
  `.trim();
}

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

const sessions = new Map();

// ── Routes ────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "World of Sugandh chatbot is running" });
});

app.post("/chat", async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "Message is required." });
  }

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required." });
  }

  try {
    // Reload data on every request so client updates reflect immediately
    const storeData = loadStoreData();
    const SYSTEM_PROMPT = buildSystemPrompt(storeData);

    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    const history = sessions.get(sessionId);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: message.trim() },
    ];

    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages,
      max_tokens: 500,
      temperature: 0.7,
    });

    const responseText = completion.choices[0].message.content;

    history.push({ role: "user", content: message.trim() });
    history.push({ role: "assistant", content: responseText });

    if (history.length > 40) history.splice(0, 2);

    res.json({ reply: responseText });

  } catch (error) {
    console.error("Groq API error:", error.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
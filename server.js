const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─────────────────────────────────────────────
// Models
// ─────────────────────────────────────────────
const PRIMARY_MODEL = "gemini-2.5-flash-lite";
const FALLBACK_MODEL = "gemini-2.5-flash";

// ─────────────────────────────────────────────
// Load store data
// ─────────────────────────────────────────────
function loadStoreData() {
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, "data.json"),
      "utf-8"
    );

    return JSON.parse(raw);
  } catch (e) {
    console.error("Failed to load data.json:", e.message);
    return null;
  }
}

function buildSystemPrompt(data) {
  if (!data) {
    return `
You are a helpful shopping assistant for "World of Sugandh", a clothing brand.

Answer general questions about fashion and clothing.

If asked about specific products, say you don't have that information right now
and suggest contacting support.
`.trim();
  }

  const { store, collections, products } = data;

  const collectionList = collections
    .map(c => `- ${c.name} (id: ${c.id})`)
    .join("\n");

  const productList = products
    .filter(
      p =>
        p &&
        p.id &&
        Array.isArray(p.collections)
    )
    .map(p => {

      const cols = p.collections
        .map(cid => {
          const found = collections.find(
            c => c.id === cid || c.name === cid
          );

          return found ? found.name : cid;
        })
        .join(", ");

      const sizes = Array.isArray(p.sizes_available)
        ? p.sizes_available.join(", ")
        : "Not available";

      const discount = p.discount_percent
        ? ` (${p.discount_percent}% off, original Rs. ${p.original_price})`
        : "";

      const measurements = p.measurements
        ? Object.entries(p.measurements)
          .map(
            ([size, m]) =>
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
Ready to Ship: ${p.ready_to_ship
          ? "Yes"
          : `No, ships in ${p.shipping_days} days`
        }
Sizes: ${sizes}
Color: ${p.details?.color || "Not available"}
Fit: ${p.details?.fit || "Not available"}
Neckline: ${p.details?.neckline || "Not available"}
Fabric: Top - ${p.fabric?.top || "Not available"}, Bottom - ${p.fabric?.bottom || "Not available"
        }
Washcare: ${p.fabric?.washcare || "Not available"}
Components: ${p.details?.number_of_components || "Not available"}
Description: ${p.details?.description || "Not available"}

Measurements:
${measurements}

URL: ${p.url}
`;
    })
    .join("\n---");

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
- Answer only based on the product data above.
- Never make up prices, sizes, availability, measurements, or product details.
- If a customer asks for a size not listed, tell them it is not available.
- When recommending products, mention the price, collection, and URL.
- For size help, use the measurements provided.
- Ask for bust/waist measurements if the customer is unsure about sizing.
- Keep responses short, warm, and helpful.
- If you don't know something, direct the customer to WhatsApp: ${store.whatsapp}
  or email: ${store.email}.
- Never discuss anything outside clothing, fashion, and World of Sugandh.
`.trim();
}

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

const sessions = new Map();

// ─────────────────────────────────────────────
// Sleep helper
// ─────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
// Gemini request with retry + fallback
// ─────────────────────────────────────────────
async function generateResponse({
  message,
  history,
  systemPrompt
}) {

  const models = [
    PRIMARY_MODEL,
    FALLBACK_MODEL
  ];

  let lastError = null;

  for (const modelName of models) {

    for (let attempt = 0; attempt < 3; attempt++) {

      try {

        console.log(
          `Gemini request → ${modelName} | attempt ${attempt + 1}`
        );

        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: systemPrompt
        });

        const chat = model.startChat({
          history: history.map(h => ({
            role:
              h.role === "assistant"
                ? "model"
                : "user",

            parts: [
              {
                text: h.content
              }
            ]
          }))
        });

        const result = await chat.sendMessage(
          message.trim()
        );

        return result.response.text();

      } catch (error) {

        lastError = error;

        const status =
          error?.status ||
          error?.response?.status;

        console.error(
          `Gemini ${modelName} attempt ${attempt + 1} failed:`,
          error.message
        );

        // Only retry temporary errors
        if (
          status !== 503 &&
          status !== 429 &&
          status !== 500 &&
          status !== 408
        ) {
          throw error;
        }

        // Exponential backoff:
        // 1s → 2s → 4s
        const delay = Math.pow(2, attempt) * 1000;

        console.log(
          `Retrying in ${delay / 1000}s...`
        );

        await sleep(delay);
      }
    }

    console.log(
      `Primary/fallback model ${modelName} failed.`
    );
  }

  throw lastError;
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "World of Sugandh chatbot is running"
  });
});

app.post("/chat", async (req, res) => {

  const {
    message,
    sessionId
  } = req.body;

  if (
    !message ||
    typeof message !== "string" ||
    message.trim() === ""
  ) {
    return res.status(400).json({
      error: "Message is required."
    });
  }

  if (
    !sessionId ||
    typeof sessionId !== "string"
  ) {
    return res.status(400).json({
      error: "sessionId is required."
    });
  }

  try {

    const storeData = loadStoreData();

    const SYSTEM_PROMPT =
      buildSystemPrompt(storeData);

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, []);
    }

    const history =
      sessions.get(sessionId);

    const responseText =
      await generateResponse({
        message,
        history,
        systemPrompt: SYSTEM_PROMPT
      });

    history.push({
      role: "user",
      content: message.trim()
    });

    history.push({
      role: "assistant",
      content: responseText
    });

    // Keep last 20 messages
    if (history.length > 40) {
      history.splice(
        0,
        history.length - 40
      );
    }

    return res.json({
      reply: responseText
    });

  } catch (error) {

    console.error(
      "Gemini API final error:",
      error.message
    );

    return res.status(503).json({
      error:
        "The AI service is temporarily busy. Please try again in a few seconds."
    });
  }
});

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(
    `Server running on port ${PORT}`
  );
});
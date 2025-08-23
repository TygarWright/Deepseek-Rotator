// index.json — OpenRouter Key Rotation Proxy
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Load keys from environment (KEY1, KEY2, KEY3, ...)
const KEYS = Object.keys(process.env)
  .filter(k => k.startsWith("KEY"))
  .sort()
  .map(k => process.env[k]);

if (KEYS.length === 0) {
  console.error("❌ No API keys found. Add KEY1, KEY2, ... as environment variables.");
  process.exit(1);
}

let current = 0;

// Rotate to next key
function rotateKey() {
  current = (current + 1) % KEYS.length;
}

// Forward request to OpenRouter with retry
async function forwardToOpenRouter(body) {
  if (!body.model) {
    body.model = process.env.MODEL || "deepseek/deepseek-chat-v3-0324:free";
  }
  if (!body.messages) {
    body.messages = [{ role: "user", content: "Hello" }];
  }

  const referer = process.env.HTTP_REFERER || "https://render.com";
  const title = process.env.X_TITLE || "OpenRouter Rotator";

  for (let tries = 0; tries < KEYS.length; tries++) {
    const key = KEYS[current];
    console.log(`🔑 Using key ${current + 1}/${KEYS.length}`);

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": title
      },
      body: JSON.stringify(body)
    });

    // Rate limit — check Retry-After if present
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      console.warn(`⚠️ Key ${current + 1} hit rate limit. Switching...`);
      rotateKey();
      if (retryAfter) {
        console.log(`⏳ Waiting ${retryAfter}s before retry...`);
        await new Promise(r => setTimeout(r, parseInt(retryAfter) * 1000));
      }
      continue;
    }

    // Invalid key
    if (res.status === 401 || res.status === 403) {
      console.warn(`🚫 Key ${current + 1} unauthorized/forbidden. Rotating...`);
      rotateKey();
      continue;
    }

    // Success or other error → pass through
    const contentType = res.headers.get("content-type") || "application/json";
    const text = await res.text();
    return { status: res.status, contentType, text };
  }

  // If we tried all keys and failed
  return {
    status: 429,
    contentType: "application/json",
    text: JSON.stringify({
      error: "All API keys are exhausted or invalid. Please wait or add more keys."
    })
  };
}

// Health check
app.get("/", (_req, res) => {
  res.type("text/plain").send("✅ OpenRouter Key Rotation Proxy is running 24/7.");
});

// Main endpoint
app.post("/chat/completions", async (req, res) => {
  try {
    const r = await forwardToOpenRouter(req.body || {});
    res.status(r.status).set("content-type", r.contentType).send(r.text);
  } catch (e) {
    console.error("💥 Proxy error:", e);
    res.status(500).json({ error: "Proxy error", detail: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Proxy live at http://localhost:${PORT}`));

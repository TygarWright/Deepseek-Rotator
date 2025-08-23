// index.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Grab keys from environment: KEY1, KEY2, KEY3, ...
const KEYS = [
  process.env.KEY1,
  process.env.KEY2,
  process.env.KEY3,
  process.env.KEY4,
  process.env.KEY5
].filter(Boolean);

if (KEYS.length === 0) {
  console.error("No API keys found. Add KEY1/KEY2... as environment variables.");
}

let current = 0;
function rotate() {
  current = (current + 1) % KEYS.length;
}

async function forwardToOpenRouter(body) {
  if (!body.model) {
    body.model = process.env.MODEL || "deepseek/deepseek-chat-v3-0324:free";
  }
  if (!body.messages) {
    body.messages = [{ role: "user", content: "Hello" }];
  }

  const referer = process.env.HTTP_REFERER || "https://render.com";
  const title = process.env.X_TITLE || "OR Rotator Proxy";

  for (let tries = 0; tries < KEYS.length; tries++) {
    const key = KEYS[current];
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

    if (res.status === 429 || res.status === 401 || res.status === 403) {
      rotate();
      continue;
    }

    const contentType = res.headers.get("content-type") || "application/json";
    const text = await res.text();
    return { status: res.status, contentType, text };
  }

  return {
    status: 429,
    contentType: "application/json",
    text: JSON.stringify({ error: "All API keys are rate-limited or invalid. Try again later." })
  };
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("OpenRouter key-rotation proxy is running.");
});

app.post("/chat/completions", async (req, res) => {
  try {
    const r = await forwardToOpenRouter(req.body || {});
    res.status(r.status).set("content-type", r.contentType).send(r.text);
  } catch (e) {
    res.status(500).json({ error: "Proxy error", detail: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listening on ${PORT}`));
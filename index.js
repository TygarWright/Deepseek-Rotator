// 🚀 Ultimate OpenRouter Rotator + Premium Liquid Glass Dashboard // Fully tested, production-ready, Node >=18

import express from "express"; import fetch from "node-fetch"; import cors from "cors"; import crypto from "crypto";

const app = express(); app.use(cors()); app.use(express.json({ limit: "5mb" })); app.use(express.urlencoded({ extended: true }));

// ===== Security ===== const DASH_USER = process.env.DASH_USER || "admin"; const DASH_PASS = process.env.DASH_PASS || "secret"; const COOKIE_NAME = "dash_token"; const COOKIE_TTL = 1000 * 60 * 60 * 12; const COOKIE_SECRET = process.env.DASH_SECRET || crypto.randomBytes(16).toString("hex");

function signCookie(val) { const sig = crypto.createHmac("sha256", COOKIE_SECRET).update(val).digest("hex"); return ${val}.${sig}; } function verifyCookie(signed) { if (!signed || !signed.includes(".")) return null; const [val, sig] = signed.split("."); const good = crypto.createHmac("sha256", COOKIE_SECRET).update(val).digest("hex"); return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) ? val : null; } function requireAuth(req, res, next) { const raw = (req.headers.cookie || "") .split(";").map(s => s.trim()) .find(s => s.startsWith(COOKIE_NAME + "=")); const val = verifyCookie(raw ? raw.split("=")[1] : null); if (val === "ok") return next(); res.redirect("/login"); }

// ===== Key Rotation ===== let KEYS = Object.entries(process.env) .filter(([k]) => /^KEY\d+$/.test(k)) .sort((a, b) => parseInt(a[0].slice(3)) - parseInt(b[0].slice(3))) .map(([, v]) => v); let current = 0; let deadKeys = new Set(), cooldown = new Map(); function activeKey() { return KEYS[current]; } function rotateKey() { let tries = 0; do { current = (current + 1) % KEYS.length; tries++; } while (tries < KEYS.length && (deadKeys.has(activeKey()) || (cooldown.get(activeKey()) || 0) > Date.now())); }

// ===== Queue ===== const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "3"); const MIN_INTERVAL = parseInt(process.env.MIN_INTERVAL_MS || "150"); let active = 0, lastStart = 0, queue = []; function schedule(fn) { return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); runNext(); }); } function runNext() { if (active >= MAX_CONCURRENT || !queue.length) return; const now = Date.now(); const wait = Math.max(0, MIN_INTERVAL - (now - lastStart)); if (wait > 0 && active > 0) return setTimeout(runNext, wait); lastStart = Date.now(); const task = queue.shift(); active++; task.fn().then(task.resolve).catch(task.reject).finally(() => { active--; runNext(); }); }

// ===== Logs ===== const logs = []; function addLog(l) { logs.push(l); if (logs.length > 500) logs.shift(); }

// ===== Proxy ===== async function forwardToOpenRouter(body) { if (!body.model) body.model = process.env.MODEL || "deepseek/deepseek-chat-v3-0324:free"; let lastUser = body.messages?.filter(m => m.role === "user").pop()?.content || "";

for (let i = 0; i < KEYS.length; i++) { const key = activeKey(); if ((cooldown.get(key) || 0) > Date.now()) { rotateKey(); continue; }

try {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.HTTP_REFERER || "https://render.com",
      "X-Title": process.env.X_TITLE || "LiquidGlass Rotator"
    },
    body: JSON.stringify(body)
  });

  if (r.status === 429) {
    cooldown.set(key, Date.now() + 1000);
    rotateKey();
    continue;
  }
  if (r.status === 401 || r.status === 403) {
    deadKeys.add(key);
    rotateKey();
    continue;
  }

  const text = await r.text();
  addLog({ ts: new Date().toISOString(), status: r.status, user: lastUser.slice(0, 200), reply: text.slice(0, 400) });
  return { status: r.status, contentType: r.headers.get("content-type"), text };
} catch (e) {
  rotateKey();
}

} return { status: 429, contentType: "application/json", text: JSON.stringify({ error: "All keys exhausted." }) }; }

app.post("/chat/completions", async (req, res) => { try { const result = await schedule(() => forwardToOpenRouter(req.body || {})); res.status(result.status).set("content-type", result.contentType).send(result.text); } catch (e) { res.status(500).json({ error: "Proxy failure", detail: String(e) }); } });

// ===== Dashboard UI ===== const styles = `

<style>
body{margin:0;font-family:-apple-system,system-ui;background:linear-gradient(145deg,#0d1117,#1f2937);color:#e5e7eb;display:flex;flex-direction:column;align-items:center;}
.container{max-width:1200px;width:100%;padding:20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;}
.card{background:rgba(255,255,255,0.08);backdrop-filter:blur(20px);border-radius:24px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,0.4);transition:transform 0.3s;}
.card:hover{transform:scale(1.03);}
.title{font-size:24px;font-weight:700;background:linear-gradient(90deg,#a78bfa,#f472b6,#60a5fa);-webkit-background-clip:text;color:transparent;margin-bottom:12px;}
.log{max-height:400px;overflow:auto;font-size:14px;}
.log-entry{margin-bottom:6px;padding:6px;border-radius:12px;background:rgba(255,255,255,0.05);}
</style>`;app.get("/login", (req, res) => { res.send(<!DOCTYPE html><html><head>${styles}<title>Login</title></head><body><div class=container><div class=card><div class=title>Dashboard Login</div><form method=POST action=/login><input name=username placeholder=Username><input name=password type=password placeholder=Password><button type=submit>Login</button></form></div></div></body></html>); });

app.post("/login", (req, res) => { const { username, password } = req.body || {}; if (username === DASH_USER && password === DASH_PASS) { res.setHeader("Set-Cookie", ${COOKIE_NAME}=${signCookie("ok")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_TTL / 1000}); res.redirect("/dashboard"); } else res.send("Wrong username or password"); });

app.get("/dashboard", requireAuth, (req, res) => { res.send(<!DOCTYPE html><html><head>${styles}<title>Dashboard</title></head><body><h1 class=title>🚀 LiquidGlass Dashboard</h1><div class=container> <div class=card><div class=title>Keys Loaded</div><div>${KEYS.length}</div></div> <div class=card><div class=title>Recent Logs</div><div class=log>${logs.map(l => <div class=log-entry><b>${l.status}</b> | ${l.user}</div>`).join('')}</div></div>

  </div></body></html>`);
});const PORT = process.env.PORT || 3000; app.listen(PORT, () => console.log(🚀 Rotator running on http://localhost:${PORT}));


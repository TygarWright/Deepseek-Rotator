// index.js — OpenRouter Proxy + Admin Dashboard (single file, no build)
// Features: login, stats, live logs, manual rotate, add/remove keys.
// Env vars you should set on Render:
//  - KEY1, KEY2, KEY3, ...       (your OpenRouter keys; you can add more later in the UI)
//  - MODEL                        (optional; default: deepseek/deepseek-chat-v3-0324:free)
//  - DASH_USER, DASH_PASS         (dashboard username/password)
//  - DASH_SECRET                  (optional; cookie secret string)
//  - HTTP_REFERER, X_TITLE       (optional; branding headers)
//  - PORT                         (Render sets this automatically; fallback 3000)

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// ===== Security: simple cookie session (no extra libs) =====
const DASH_USER = process.env.DASH_USER || "admin";
const DASH_PASS = process.env.DASH_PASS || "secret";
const COOKIE_NAME = "dash_token";
const COOKIE_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const COOKIE_SECRET = process.env.DASH_SECRET || crypto.randomBytes(16).toString("hex");

function sign(val) {
  const h = crypto.createHmac("sha256", COOKIE_SECRET).update(val).digest("hex");
  return `${val}.${h}`;
}
function verify(signed) {
  if (!signed || !signed.includes(".")) return null;
  const [val, h] = signed.split(".");
  const good = crypto.createHmac("sha256", COOKIE_SECRET).update(val).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(good)) ? val : null;
}
function setCookie(res, name, value, ttl) {
  const expires = new Date(Date.now() + ttl).toUTCString();
  res.setHeader(
    "Set-Cookie",
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttl/1000)}; Expires=${expires}`
  );
}
function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}
function requireAuth(req, res, next) {
  const cookie = (req.headers.cookie || "")
    .split(";")
    .map(s => s.trim())
    .find(s => s.startsWith(COOKIE_NAME + "="));
  const raw = cookie ? cookie.split("=")[1] : null;
  const val = verify(raw);
  if (val === "ok") return next();
  res.status(302).set("Location", "/login").end();
}

// ===== Keys & rotation =====
let KEYS = Object.entries(process.env)
  .filter(([k]) => /^KEY\d+$/.test(k))
  .sort((a,b) => {
    // sort by number (KEY1, KEY2, ...)
    const ai = parseInt(a[0].replace("KEY",""), 10);
    const bi = parseInt(b[0].replace("KEY",""), 10);
    return ai - bi;
  })
  .map(([,v]) => v)
  .filter(Boolean);

if (KEYS.length === 0) {
  console.error("❌ No API keys found. Please set KEY1, KEY2, ... in environment variables.");
}

let current = 0;
let rotations = 0;
let deadKeys = new Set();            // invalid/forbidden keys
let rateLimitedKeys = new Set();     // hit 429 recently
const keyUseCount = new Map();       // key => count

function activeKey() { return KEYS[current]; }
function rotateKey(manual = false) {
  const total = KEYS.length || 1;
  let tries = 0;
  do {
    current = (current + 1) % total;
    tries++;
  } while (tries <= total && (deadKeys.has(KEYS[current]))); // skip dead keys
  rotations += 1;
  if (manual) console.log(`🔁 Manual rotate → now key #${current+1}/${KEYS.length}`);
}

// ===== Request queue (soft rate-limiter) =====
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "3", 10);
const MIN_INTERVAL_MS = parseInt(process.env.MIN_INTERVAL_MS || "200", 10);
let active = 0;
let lastStart = 0;
const queue = [];
function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
}
function runNext() {
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastStart));
  if (wait > 0 && active > 0) {
    setTimeout(runNext, wait);
    return;
  }
  lastStart = Date.now();
  const task = queue.shift();
  active++;
  task.fn()
    .then(v => task.resolve(v))
    .catch(e => task.reject(e))
    .finally(() => { active--; runNext(); });
}

// ===== Logs (admin only; in-memory ring buffer) =====
const MAX_LOGS = 500;
const logs = []; // each: { ts, keyIndex, user, reply, latencyMs, status }
function addLog(entry) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
}
function maskKey(k) {
  if (!k || k.length < 8) return "sk-****";
  return `${k.slice(0, 6)}...${k.slice(-4)}`;
}

// ===== OpenRouter forwarding =====
async function forwardToOpenRouter(body) {
  const start = Date.now();

  if (!body.model) {
    body.model = process.env.MODEL || "deepseek/deepseek-chat-v3-0324:free";
  }
  if (!body.messages) {
    body.messages = [{ role: "user", content: "Hello" }];
  }

  const referer = process.env.HTTP_REFERER || "https://render.com";
  const title = process.env.X_TITLE || "OpenRouter Rotator";

  // Extract latest user message for logs
  let lastUserMsg = "";
  try {
    const lastUser = [...body.messages].reverse().find(m => m.role === "user");
    lastUserMsg = lastUser?.content?.toString()?.slice(0, 1000) || "";
  } catch {}

  for (let tries = 0; tries < KEYS.length; tries++) {
    const key = activeKey();
    const keyIndex = current;

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

    // Rate limit
    if (res.status === 429) {
      rateLimitedKeys.add(key);
      const retryAfter = res.headers.get("retry-after");
      console.warn(`⚠️ 429 on key #${keyIndex+1}. Rotating...`);
      rotateKey();
      const waitMs = retryAfter ? parseInt(retryAfter)*1000 : 500 + Math.floor(Math.random()*750);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // Invalid/forbidden
    if (res.status === 401 || res.status === 403) {
      console.warn(`🚫 ${res.status} on key #${keyIndex+1}. Mark dead + rotate.`);
      deadKeys.add(key);
      rotateKey();
      continue;
    }

    // Success or other error — record + return
    const contentType = res.headers.get("content-type") || "application/json";
    const text = await res.text();
    const latencyMs = Date.now() - start;

    // count usage on success-ish responses
    keyUseCount.set(key, 1 + (keyUseCount.get(key) || 0));

    // Try to parse model reply for logging
    let modelReply = "";
    try {
      const j = JSON.parse(text);
      modelReply = j?.choices?.[0]?.message?.content || "";
    } catch {
      // keep empty if non-JSON
    }

    addLog({
      ts: new Date().toISOString(),
      keyIndex: keyIndex + 1,
      user: lastUserMsg,
      reply: modelReply?.toString()?.slice(0, 2000) || "",
      latencyMs,
      status: res.status
    });

    return { status: res.status, contentType, text };
  }

  // All keys failed
  const latencyMs = Date.now() - start;
  addLog({
    ts: new Date().toISOString(),
    keyIndex: 0,
    user: lastUserMsg,
    reply: "",
    latencyMs,
    status: 429
  });

  return {
    status: 429,
    contentType: "application/json",
    text: JSON.stringify({
      error: "All API keys are exhausted or invalid. Please wait or add more keys."
    })
  };
}

// ===== Proxy endpoint (OpenAI-compatible) =====
app.post("/chat/completions", async (req, res) => {
  try {
    const result = await schedule(() => forwardToOpenRouter(req.body || {}));
    res.status(result.status).set("content-type", result.contentType).send(result.text);
  } catch (e) {
    console.error("💥 Proxy error:", e);
    res.status(500).json({ error: "Proxy error", detail: String(e) });
  }
});

// ===== Admin pages (login + dashboard) =====
const baseStyles = `
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background: radial-gradient(1200px 600px at 20% -10%, #1f2937, transparent), linear-gradient(135deg, #0b1020, #111827); color: #e5e7eb; }
    a { color: #93c5fd; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 16px 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.25); }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    .title { font-size: 26px; font-weight: 800; letter-spacing: .5px; margin: 12px 0 20px; background: linear-gradient(90deg, #a78bfa, #f472b6, #60a5fa); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .btn { background: linear-gradient(90deg, #6366f1, #06b6d4); color:white; border:0; padding:10px 14px; border-radius:12px; cursor:pointer; transition: transform .06s ease; }
    .btn:active { transform: scale(.98); }
    .danger { background: linear-gradient(90deg, #ef4444, #f59e0b); }
    .muted { color:#9ca3af; font-size: 12px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .stat { font-size: 28px; font-weight: 800; }
    .green { color: #34d399; } .yellow { color:#fbbf24; } .red { color:#f87171; }
    .log { background: rgba(0,0,0,0.35); border-radius: 12px; padding: 12px; height: 360px; overflow: auto; border:1px solid rgba(255,255,255,0.08);}
    .row { margin-bottom: 10px; }
    .pill { display:inline-block; background:rgba(255,255,255,0.08); padding:2px 8px; border-radius:999px; font-size:12px; }
    .mask { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .logo { font-weight:900; letter-spacing:.5px; }
    .fade { animation: fadein .5s ease; }
    @keyframes fadein { from { opacity:0; transform: translateY(6px);} to {opacity:1; transform:none;} }
  </style>
`;

app.get("/login", (req, res) => {
  res.send(`
  <html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
  ${baseStyles}
  <title>Login • Proxy Dashboard</title></head>
  <body><div class="wrap">
    <div class="card fade" style="max-width:420px; margin: 10vh auto;">
      <div class="title">Secure Login</div>
      <form method="POST" action="/login">
        <div><input name="username" placeholder="Username" style="width:100%; padding:12px; border-radius:10px; background:#0b1220; color:#e5e7eb; border:1px solid #1f2937;"></div>
        <div style="margin-top:10px;"><input name="password" type="password" placeholder="Password" style="width:100%; padding:12px; border-radius:10px; background:#0b1220; color:#e5e7eb; border:1px solid #1f2937;"></div>
        <div style="margin-top:14px; display:flex; gap:10px; align-items:center;">
          <button class="btn" type="submit">Login</button>
          <a href="/" class="muted">Back</a>
        </div>
      </form>
    </div>
  </div></body></html>`);
});

app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === DASH_USER && password === DASH_PASS) {
    setCookie(res, COOKIE_NAME, sign("ok"), COOKIE_TTL_MS);
    res.redirect("/dashboard");
  } else {
    res.send(`<p style="padding:24px;">❌ Wrong username or password. <a href="/login">Try again</a></p>`);
  }
});

app.get("/logout", (req, res) => {
  clearCookie(res, COOKIE_NAME);
  res.redirect("/login");
});

// Root: redirect to dashboard or login
app.get("/", (req, res) => {
  const cookie = (req.headers.cookie || "").includes(COOKIE_NAME+"=");
  res.redirect(cookie ? "/dashboard" : "/login");
});

// Dashboard UI
app.get("/dashboard", requireAuth, (req, res) => {
  const upMs = process.uptime() * 1000;
  const upMin = Math.floor(upMs/60000);
  const activeIdx = KEYS.length ? current+1 : 0;
  const keyList = KEYS.map((k,i) => {
    const dead = deadKeys.has(k);
    const rl = rateLimitedKeys.has(k);
    const classes = dead ? "red" : rl ? "yellow" : "green";
    return `<div class="row"><span class="pill ${classes}">#${i+1}</span> <span class="mask">${maskKey(k)}</span> ${i===current?' <span class="pill">active</span>':''}</div>`;
  }).join("");

  res.send(`
  <html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
  ${baseStyles}
  <title>Admin • Proxy Dashboard</title></head>
  <body>
    <div class="wrap">
      <div class="top">
        <div class="logo">🚀 OpenRouter Rotator • Admin</div>
        <div><a class="pill" href="/logout">Logout</a></div>
      </div>

      <div class="grid" style="margin-top:16px;">
        <div class="card fade">
          <div class="title">System</div>
          <div>Uptime: <b>${upMin} min</b></div>
          <div>Active key: <b>#${activeIdx}</b> of <b>${KEYS.length}</b></div>
          <div>Rotations: <b>${rotations}</b></div>
          <div>Queue: <b>${queue.length}</b> • Active: <b>${active}</b></div>
        </div>

        <div class="card fade">
          <div class="title">Keys</div>
          ${keyList || '<div class="muted">No keys loaded</div>'}
          <div style="margin-top:12px; display:flex; gap:8px;">
            <form method="POST" action="/admin/rotate"><button class="btn" type="submit">Force Rotate</button></form>
            <form method="POST" action="/admin/clear-dead"><button class="btn" type="submit">Clear Dead/429 Flags</button></form>
          </div>
          <div style="margin-top:12px;">
            <form method="POST" action="/admin/add-key">
              <input name="newKey" placeholder="Paste new KEY here" style="width:100%; padding:10px; border-radius:10px; background:#0b1220; color:#e5e7eb; border:1px solid #1f2937;">
              <button class="btn" type="submit" style="margin-top:8px;">Add Key (runtime)</button>
            </form>
          </div>
          <div class="muted" style="margin-top:8px;">Runtime-added keys are not saved after a restart.</div>
        </div>

        <div class="card fade">
          <div class="title">Analytics</div>
          <div>Total requests: <b>${logs.length}</b></div>
          <div>Avg latency: <b>${
            logs.length
              ? Math.round(logs.reduce((a,b)=>a+b.latencyMs,0)/logs.length)
              : 0
          } ms</b></div>
          <div style="margin-top:10px;">
            <form method="POST" action="/admin/clear-logs" style="display:inline;">
              <button class="btn danger" type="submit">Clear Logs</button>
            </form>
            <a class="btn" style="margin-left:8px;" href="/admin/download-logs">Download Logs</a>
          </div>
        </div>

        <div class="card fade" style="grid-column: 1 / -1;">
          <div class="title">Live Logs</div>
          <div class="log" id="logbox">${renderLogs(logs.slice(-100))}</div>
          <div class="muted">Auto-refreshing…</div>
        </div>
      </div>
    </div>

    <script>
      async function refreshLogs(){
        try{
          const res = await fetch('/admin/logs');
          if(!res.ok) return;
          const data = await res.json();
          const box = document.getElementById('logbox');
          box.innerHTML = data.html;
          box.scrollTop = box.scrollHeight;
        }catch(e){}
      }
      setInterval(refreshLogs, 4000);
      refreshLogs();
    </script>
  </body></html>`);
});

function renderLogs(items){
  if (!items.length) return '<div class="muted">No logs yet.</div>';
  return items.map(it=>{
    const cls = it.status >=200 && it.status < 400 ? 'green' : (it.status===429?'yellow':'red');
    return `
      <div class="row">
        <span class="muted">${new Date(it.ts).toLocaleTimeString()}</span>
        <span class="pill ${cls}">#${it.keyIndex||'-'} • ${it.status}</span>
        <span class="pill">${it.latencyMs} ms</span>
        <div class="mono" style="margin-top:4px;"><b>[USER]</b> ${escapeHtml(it.user||'')}</div>
        ${it.reply ? `<div class="mono" style="margin-top:4px;"><b>[BOT]</b> ${escapeHtml(it.reply)}</div>` : ''}
      </div>`;
  }).join("");
}
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ===== Admin JSON endpoints =====
app.get("/admin/logs", requireAuth, (req, res) => {
  res.json({ html: renderLogs(logs.slice(-100)) });
});
app.get("/admin/status", requireAuth, (req, res) => {
  res.json({
    totalKeys: KEYS.length,
    activeKeyIndex: current+1,
    rotations,
    deadKeys: [...deadKeys].map(maskKey),
    rateLimitedKeys: [...rateLimitedKeys].map(maskKey),
    queue: queue.length,
    active
  });
});
app.post("/admin/rotate", requireAuth, (req, res) => {
  rotateKey(true);
  res.redirect("/dashboard");
});
app.post("/admin/clear-dead", requireAuth, (req, res) => {
  deadKeys.clear();
  rateLimitedKeys.clear();
  res.redirect("/dashboard");
});
app.post("/admin/clear-logs", requireAuth, (req, res) => {
  logs.length = 0;
  res.redirect("/dashboard");
});
app.get("/admin/download-logs", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", "attachment; filename=logs.json");
  res.send(JSON.stringify(logs, null, 2));
});
app.post("/admin/add-key", requireAuth, (req, res) => {
  const k = (req.body?.newKey || "").trim();
  if (k && !KEYS.includes(k)) {
    KEYS.push(k);
    console.log(`➕ Added key (runtime): ${maskKey(k)}`);
  }
  res.redirect("/dashboard");
});

// ===== Fallback /health =====
app.get("/health", (_req, res) => {
  res.type("text/plain").send("ok");
});

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Proxy + Admin running on :${PORT}`));

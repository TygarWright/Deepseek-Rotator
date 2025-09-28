// Ultimate OpenRouter Rotator + Liquid Glass Dashboard
// Single file, no build required, Node ≥18
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// ===== Dashboard Security =====
const DASH_USER = process.env.DASH_USER || "admin";
const DASH_PASS = process.env.DASH_PASS || "secret";
const COOKIE_NAME = "dash_token";
const COOKIE_TTL_MS = 1000 * 60 * 60 * 12; // 12h
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

// ===== Key Rotation & Cooldowns =====
let KEYS = Object.entries(process.env)
  .filter(([k]) => /^KEY\d+$/.test(k))
  .sort((a,b) => parseInt(a[0].replace("KEY",""),10)-parseInt(b[0].replace("KEY",""),10))
  .map(([,v]) => v)
  .filter(Boolean);

let current = 0;
let rotations = 0;
let deadKeys = new Set();
let rateLimitedKeys = new Set();
const keyUseCount = new Map();
const keyCooldown = new Map(); // key -> timestamp last used

function activeKey() { return KEYS[current]; }
function rotateKey(manual=false) {
  const total = KEYS.length || 1;
  let tries = 0;
  do {
    current = (current + 1) % total;
    tries++;
  } while (tries <= total && (deadKeys.has(KEYS[current]) || (keyCooldown.get(KEYS[current])||0) > Date.now()));
  rotations += 1;
  if(manual) console.log(`🔁 Manual rotate → now key #${current+1}/${KEYS.length}`);
}

// ===== Request Queue & Soft Rate Limit =====
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "3");
const MIN_INTERVAL_MS = parseInt(process.env.MIN_INTERVAL_MS || "150");
let active = 0;
let lastStart = 0;
const queue = [];
function schedule(fn) {
  return new Promise((resolve, reject) => { queue.push({fn, resolve, reject}); runNext(); });
}
function runNext() {
  if(active>=MAX_CONCURRENT || queue.length===0) return;
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now-lastStart));
  if(wait>0 && active>0){ setTimeout(runNext, wait); return; }
  lastStart = Date.now();
  const task = queue.shift();
  active++;
  task.fn().then(v=>task.resolve(v)).catch(e=>task.reject(e)).finally(()=>{active--; runNext();});
}

// ===== Logs =====
const MAX_LOGS=500;
const logs=[];
function addLog(entry){ logs.push(entry); if(logs.length>MAX_LOGS) logs.shift(); }
function maskKey(k){ return k && k.length>8 ? `${k.slice(0,6)}...${k.slice(-4)}` : "sk-****"; }

// ===== OpenRouter Forwarding =====
async function forwardToOpenRouter(body){
  const start=Date.now();
  if(!body.model) body.model=process.env.MODEL||"deepseek/deepseek-chat-v3-0324:free";
  if(!body.messages) body.messages=[{role:"user", content:"Hello"}];
  const referer = process.env.HTTP_REFERER || "https://render.com";
  const title = process.env.X_TITLE || "LiquidGlass Rotator";

  let lastUserMsg="";
  try{ const lastUser=[...body.messages].reverse().find(m=>m.role==="user"); lastUserMsg=lastUser?.content?.toString()?.slice(0,1000)||""; }catch{}

  for(let tries=0; tries<KEYS.length; tries++){
    const key=activeKey();
    const keyIndex=current;

    const now=Date.now();
    if((keyCooldown.get(key)||0)>now){ rotateKey(); continue; }

    let res;
    try {
      res=await fetch("https://openrouter.ai/api/v1/chat/completions",{
        method:"POST",
        headers:{
          "Authorization":`Bearer ${key}`,
          "Content-Type":"application/json",
          "HTTP-Referer":referer,
          "X-Title":title
        },
        body:JSON.stringify(body)
      });
    } catch(e){ console.error("Fetch error:",e); rotateKey(); continue; }

    const latencyMs=Date.now()-start;

    if(res.status===429){
      rateLimitedKeys.add(key);
      const retryAfter = parseInt(res.headers.get("retry-after")||0)*1000 || 500+Math.floor(Math.random()*750);
      keyCooldown.set(key, Date.now()+retryAfter);
      console.warn(`⚠️ 429 on key #${keyIndex+1}, rotating...`);
      rotateKey();
      await new Promise(r=>setTimeout(r, retryAfter));
      continue;
    }

    if(res.status===401||res.status===403){
      deadKeys.add(key); rotateKey(); continue;
    }

    const text=await res.text();
    keyUseCount.set(key,1+(keyUseCount.get(key)||0));
    addLog({
      ts:new Date().toISOString(),
      keyIndex:keyIndex+1,
      user:lastUserMsg,
      reply:text.slice(0,2000),
      latencyMs,
      status:res.status
    });
    keyCooldown.set(key, Date.now()+50); // small inter-request buffer
    return {status:res.status, contentType:res.headers.get("content-type")||"application/json", text};
  }

  addLog({ts:new Date().toISOString(), keyIndex:0, user:lastUserMsg, reply:"", latencyMs:Date.now()-start, status:429});
  return {status:429, contentType:"application/json", text:JSON.stringify({error:"All API keys exhausted or invalid. Please wait or add more keys."})};
}

// ===== Proxy Endpoint =====
app.post("/chat/completions", async(req,res)=>{
  try{ const result=await schedule(()=>forwardToOpenRouter(req.body||{}));
    res.status(result.status).set("content-type", result.contentType).send(result.text);
  }catch(e){ console.error("💥 Proxy error:",e); res.status(500).json({error:"Proxy error", detail:String(e)});}
});

// ===== Liquid Glass Dashboard Styles =====
const baseStyles=`<style>
body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:linear-gradient(160deg,#0d1117,#111827);color:#e5e7eb;}
a{color:#60a5fa;}
.wrap{max-width:1400px;margin:0 auto;padding:24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:20px;}
.card{background:rgba(255,255,255,0.08);backdrop-filter:blur(24px);border-radius:24px;padding:20px;box-shadow:0 12px 35px rgba(0,0,0,0.25);transition:transform 0.2s;}
.card:hover{transform:scale(1.03);}
.title{font-size:28px;font-weight:700;background:linear-gradient(90deg,#a78bfa,#f472b6,#60a5fa);-webkit-background-clip:text;color:transparent;margin-bottom:12px;}
.btn{background:linear-gradient(90deg,#6366f1,#06b6d4);color:white;border:0;padding:10px 16px;border-radius:16px;cursor:pointer;transition:transform .1s ease;}
.btn:hover{transform:scale(1.03);}
.danger{background:linear-gradient(90deg,#ef4444,#f59e0b);}
.muted{color:#9ca3af;font-size:12px;}
.mask{font-family:ui-monospace,Menlo,Consolas,monospace;}
.stat{font-size:36px;font-weight:800;text-align:center;}
.log-panel{background:rgba(0,0,0,0.35);border-radius:20px;padding:16px;height:400px;overflow:auto;border:1px solid rgba(255,255,255,0.08);}
.log-row{margin-bottom:8px;padding:8px;border-radius:16px;transition:background 0.3s;}
.row span{margin-right:6px;}
.pill{display:inline-block;background:rgba(255,255,255,0.12);padding:2px 8px;border-radius:999px;font-size:12px;}
.green{color:#34d399;}.yellow{color:#fbbf24;}.red{color:#f87171;}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;}
</style>`;

// ===== Utilities =====
function escapeHtml(s){return(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

// ===== Dashboard Routes =====
app.get("/login",(req,res)=>{
  res.send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />${baseStyles}<title>Login</title></head><body><div class="wrap"><div class="card" style="max-width:420px;margin:10vh auto;"><div class="title">Secure Login</div><form method="POST" action="/login"><input name="username" placeholder="Username" style="width:100%;padding:12px;border-radius:12px;margin-top:10px;background:#0b1220;color:#e5e7eb;border:1px solid #1f2937;"><input name="password" type="password" placeholder="Password" style="width:100%;padding:12px;border-radius:12px;margin-top:10px;background:#0b1220;color:#e5e7eb;border:1px solid #1f2937;"><div style="margin-top:14px;"><button class="btn" type="submit">Login</button></div></form></div></div></body></html>`);
});

app.post("/login",(req,res)=>{
  const {username,password}=req.body||{};
  if(username===DASH_USER&&password===DASH_PASS){setCookie(res,COOKIE_NAME,sign("ok"),COOKIE_TTL_MS);res.redirect("/dashboard");}
  else res.send(`<p style="padding:24px;">❌ Wrong username or password. <a href="/login">Try again</a></p>`);
});

app.get("/logout",(req,res)=>{clearCookie(res,COOKIE_NAME);res.redirect("/login");});
app.get("/",(req,res)=>{res.redirect((req.headers.cookie||"").includes(COOKIE_NAME+"=")?"/dashboard":"/login");});

// ===== SSE for live stats/logs =====
app.get("/stream", requireAuth, (req,res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendData = () => {
    const upMin = Math.floor(process.uptime() * 1000 / 60000);
    const activeIdx = current;
    const data = JSON.stringify({
      uptime: upMin,
      activeKey: activeIdx + 1,
      rotations,
      deadKeys: deadKeys.size,
      rateLimited: rateLimitedKeys.size,
      logs: logs.slice(-20)
    });
    res.write(`data: ${data}\n\n`);
  };

  const interval = setInterval(sendData, 1000);

  req.on("close", () => clearInterval(interval));
});

// ===== Dashboard =====
app.get("/dashboard", requireAuth, (req,res)=>{
  res.send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1">${baseStyles}<title>LiquidGlass Dashboard</title></head><body>
  <div class="wrap">
    <div class="card stat-card"><div class="title">Uptime (min)</div><div class="stat stat-value">0</div></div>
    <div class="card stat-card"><div class="title">Active Key</div><div class="stat stat-value">0</div></div>
    <div class="card stat-card"><div class="title">Rotations</div><div class="stat stat-value">0</div></div>
    <div class="card stat-card"><div class="title">Dead Keys</div><div class="stat stat-value">0</div></div>
    <div class="card stat-card"><div class="title">Rate-Limited Keys</div><div class="stat stat-value">0</div></div>
    <div class="card log-panel"></div>
  </div>
  <script>
  const stats = {
    uptime: document.querySelector('.stat-card:nth-child(1) .stat-value'),
    activeKey: document.querySelector('.stat-card:nth-child(2) .stat-value'),
    rotations: document.querySelector('.stat-card:nth-child(3) .stat-value'),
    deadKeys: document.querySelector('.stat-card:nth-child(4) .stat-value'),
    rateLimited: document.querySelector('.stat-card:nth-child(5) .stat-value'),
    logPanel: document.querySelector('.log-panel')
  };
  const evtSource = new EventSource("/stream");
  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    stats.uptime.textContent = data.uptime;
    stats.activeKey.textContent = data.activeKey;
    stats.rotations.textContent = data.rotations;
    stats.deadKeys.textContent = data.deadKeys;
    stats.rateLimited.textContent = data.rateLimited;

    stats.logPanel.innerHTML = data.logs.map(it => \`
      <div class="log-row" style="background:\${it.status>=200&&it.status<400?'rgba(52,211,153,0.1)':it.status===429?'rgba(251,191,36,0.1)':'rgba(248,113,113,0.1)'};">
        <span class="muted">\${new Date(it.ts).toLocaleTimeString()}</span>
        <span class="pill \${it.status>=200&&it.status<400?'green':it.status===429?'yellow':'red'}">#\${it.keyIndex||'-'} • \${it.status}</span>
        <span class="pill">\${it.latencyMs} ms</span>
        <div class="mask"><b>[USER]</b> \${it.user||''}</div>
        ${it.reply?'<div class="mask"><b>[BOT]</b> ' + it.reply + '</div>':''}
      </div>\`).join('');
  };
  </script>
  </body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`🚀 Dashboard running on http://localhost:${PORT}`));

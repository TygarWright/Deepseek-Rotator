import http from "http";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import url from "url";
import dotenv from "dotenv";

dotenv.config();

// Load API keys
let KEYS = process.env.KEYS ? process.env.KEYS.split(",") : [];
let currentKeyIndex = 0;
let cooldownKeys = new Map(); // key -> timestamp when usable again
const COOLDOWN_MS = 60 * 1000; // 1 minute cooldown after 429

// Persist keys into .env
function saveKeysToEnv(keys) {
  const envPath = path.resolve(process.cwd(), ".env");
  let envContent = "";

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf8");
  }

  if (envContent.includes("KEYS=")) {
    envContent = envContent.replace(/KEYS=.*/g, `KEYS=${keys.join(",")}`);
  } else {
    envContent += `\nKEYS=${keys.join(",")}\n`;
  }

  fs.writeFileSync(envPath, envContent, "utf8");
  process.env.KEYS = keys.join(",");
}

// Pick usable key
function getCurrentKey() {
  let key = KEYS[currentKeyIndex % KEYS.length];
  let cooldownUntil = cooldownKeys.get(key);

  if (cooldownUntil && cooldownUntil > Date.now()) {
    // rotate to next available
    for (let i = 0; i < KEYS.length; i++) {
      let nextKey = KEYS[(currentKeyIndex + i) % KEYS.length];
      if (!cooldownKeys.get(nextKey) || cooldownKeys.get(nextKey) < Date.now()) {
        currentKeyIndex = (currentKeyIndex + i) % KEYS.length;
        return KEYS[currentKeyIndex];
      }
    }
    return null; // all cooling down
  }
  return key;
}

// Proxy server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // Dashboard UI
  if (req.method === "GET" && parsedUrl.pathname === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>Key Dashboard</title>
        <style>
          body {
            margin: 0;
            font-family: 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #141e30, #243b55);
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
          }
          .card {
            backdrop-filter: blur(20px) saturate(150%);
            -webkit-backdrop-filter: blur(20px) saturate(150%);
            background-color: rgba(255, 255, 255, 0.15);
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.3);
            padding: 30px;
            max-width: 500px;
            width: 100%;
            color: #fff;
            box-shadow: 0 8px 32px rgba(0,0,0,0.25);
          }
          h2 { margin-bottom: 15px; }
          input, button {
            padding: 10px 15px;
            border-radius: 10px;
            border: none;
            margin: 5px 0;
            font-size: 14px;
          }
          input {
            width: 70%;
          }
          button {
            background: rgba(255,255,255,0.25);
            color: #fff;
            cursor: pointer;
            transition: all 0.2s ease;
          }
          button:hover {
            background: rgba(255,255,255,0.4);
          }
          ul { list-style: none; padding: 0; }
          li {
            margin: 5px 0;
            padding: 8px 12px;
            background: rgba(255,255,255,0.1);
            border-radius: 8px;
            font-size: 13px;
            word-break: break-all;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🔑 API Key Dashboard</h2>
          <form onsubmit="addKey(event)">
            <input id="newKey" type="text" placeholder="Enter new key" required />
            <button type="submit">Add Key</button>
          </form>
          <button onclick="saveEnv()">💾 Save Keys to .env</button>
          <h3>Current Keys</h3>
          <ul id="keysList"></ul>
        </div>
        <script>
          async function fetchKeys() {
            let res = await fetch("/keys");
            let keys = await res.json();
            let list = document.getElementById("keysList");
            list.innerHTML = "";
            keys.forEach(k => {
              let li = document.createElement("li");
              li.textContent = k;
              list.appendChild(li);
            });
          }
          async function addKey(e) {
            e.preventDefault();
            let key = document.getElementById("newKey").value;
            await fetch("/add-key", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ newKey: key })
            });
            document.getElementById("newKey").value = "";
            fetchKeys();
          }
          async function saveEnv() {
            await fetch("/save-env", { method: "POST" });
            alert("✅ Keys saved to .env file!");
          }
          fetchKeys();
        </script>
      </body>
      </html>
    `);
    return;
  }

  // Get keys list
  if (req.method === "GET" && parsedUrl.pathname === "/keys") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(KEYS));
    return;
  }

  // Add key
  if (req.method === "POST" && parsedUrl.pathname === "/add-key") {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", () => {
      const { newKey } = JSON.parse(body);
      if (newKey) {
        KEYS.push(newKey);
        saveKeysToEnv(KEYS);
        console.log(`✅ Added new key: ${newKey}`);
      }
      res.writeHead(200);
      res.end("OK");
    });
    return;
  }

  // Save keys to env
  if (req.method === "POST" && parsedUrl.pathname === "/save-env") {
    saveKeysToEnv(KEYS);
    console.log("✅ All keys saved into .env");
    res.writeHead(200);
    res.end("Keys written to .env");
    return;
  }

  // Proxy handler
  if (req.method === "POST" && parsedUrl.pathname === "/proxy") {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", async () => {
      const requestData = JSON.parse(body);
      let key = getCurrentKey();

      if (!key) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "All keys cooling down, try later" }));
        return;
      }

      try {
        let apiRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`
          },
          body: JSON.stringify(requestData)
        });

        if (apiRes.status === 429) {
          cooldownKeys.set(key, Date.now() + COOLDOWN_MS);
          console.log(`⚠️ Key ${key} hit 429, cooling down.`);
          currentKeyIndex = (currentKeyIndex + 1) % KEYS.length;
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Rate limited, key switched." }));
          return;
        }

        const data = await apiRes.text();
        res.writeHead(apiRes.status, { "Content-Type": "application/json" });
        res.end(data);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// Start
server.listen(3000, () => {
  console.log("🚀 Proxy running at http://localhost:3000");
  console.log("🔑 Dashboard: http://localhost:3000/dashboard");
});

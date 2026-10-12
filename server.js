// Lacuna OS サーバー: 画面の配信 + Wisp(中継) + 合言葉による接続制限
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PASS = process.env.ACCESS_PASSPHRASE || "";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const MAX_CONN = Number(process.env.WISP_MAX_CONN) || 20; // 1つのIPが同時に張れるWisp接続の上限
const COOKIE = "lacuna_sess";

if (!PASS) console.warn("[warn] ACCESS_PASSPHRASE が未設定です。Wisp(中継)は無効のままです。");
if (!process.env.SESSION_SECRET) console.warn("[warn] SESSION_SECRET が未設定です。再起動するとログイン状態が消えます。");

// 内部ネットワークへの接続を禁止(SSRF対策)
wisp.options.allow_loopback_ips = false;
wisp.options.allow_private_ips = false;

// ---- 認証まわり ----
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
const makeToken = () => { const v = String(Date.now() + 7 * 864e5); return v + "." + sign(v); };
function okToken(t) {
  if (!t) return false;
  const [v, s] = t.split(".");
  if (!v || !s) return false;
  const a = Buffer.from(sign(v)), b = Buffer.from(s);
  return a.length === b.length && crypto.timingSafeEqual(a, b) && Number(v) > Date.now();
}
function getCookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
const clientIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

// ---- 総当たり対策: IPごとに10分で5回、全体で10分に50回まで ----
const tries = new Map();
let globalTries = [];
const recent = (a) => a.filter((t) => Date.now() - t < 600000);
function limited(ip) {
  const a = recent(tries.get(ip) || []);
  tries.set(ip, a);
  globalTries = recent(globalTries);
  return a.length >= 5 || globalTries.length >= 50;
}
function failed(ip) { tries.get(ip).push(Date.now()); globalTries.push(Date.now()); }

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  // QEMU Wasmなど、SharedArrayBufferを使うものに必要。ブラウザアプリ(iframe)とは両立しにくいので、ISOLATION=1 の時だけ付ける
  if (process.env.ISOLATION === "1") {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  next();
});
app.use(express.json({ limit: "1kb" }));
app.get("/sw.js", (q, r, n) => { r.setHeader("Cache-Control", "no-cache"); n(); });

app.get("/healthz", (q, r) => r.type("text").send("ok")); // uptimeボット用
app.get("/api/session", (q, r) => r.json({ ok: okToken(getCookie(q, COOKIE)) }));
app.post("/api/unlock", (req, res) => {
  const ip = clientIp(req);
  if (!PASS) return res.status(503).json({ ok: false, error: "サーバーに ACCESS_PASSPHRASE が設定されていません" });
  if (limited(ip)) return res.status(429).json({ ok: false, error: "試行回数が多すぎます。10分後にもう一度試してください" });
  const h = (s) => crypto.createHash("sha256").update(s).digest();
  const given = String((req.body && req.body.pass) || "");
  if (!crypto.timingSafeEqual(h(given), h(PASS))) { failed(ip); return res.status(401).json({ ok: false, error: "合言葉が違います" }); }
  res.setHeader("Set-Cookie", `${COOKIE}=${makeToken()}; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict${req.secure ? "; Secure" : ""}`);
  res.json({ ok: true });
});
app.post("/api/lock", (req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`);
  res.json({ ok: true });
});

// ---- 中継に必要なファイルを配る(読み込めなければ警告だけ出す)----
async function mount(prefix, specs, pick) {
  if (!specs.length) {
    const dir = pick({});
    if (fs.existsSync(dir)) { app.use(prefix, express.static(dir)); return; }
  }
  for (const spec of specs) {
    try {
      const dir = pick(await import(spec));
      if (dir && fs.existsSync(dir)) { app.use(prefix, express.static(dir)); return; }
    } catch { /* 次の候補へ */ }
  }
  console.warn(`[warn] ${prefix} を読み込めませんでした: ${specs.join(", ")}`);
}
const dist = path.join(__dirname, "node_modules/@mercuryworkshop/scramjet/dist");
await mount("/baremux/", ["@mercuryworkshop/bare-mux/node"], (m) => m.baremuxPath);
// epoxy / libcurl はブラウザ用の部品なので、パッケージの dist フォルダをそのまま配る
const pkgDist = (name) => path.join(__dirname, "node_modules/@mercuryworkshop", name, "dist");
await mount("/epoxy/", [], () => pkgDist("epoxy-transport"));
await mount("/libcurl/", [], () => pkgDist("libcurl-transport"));
// フォントは自分のサーバーから配る(外部サイトだと、cross-origin isolationで読み込めないことがあるため)
const fontDir = (name) => path.join(__dirname, "node_modules/@fontsource", name);
await mount("/fonts/zen-maru/", [], () => fontDir("zen-maru-gothic"));
await mount("/fonts/jetbrains/", [], () => fontDir("jetbrains-mono"));
app.use("/scram/", express.static(path.join(__dirname, "node_modules/@mercuryworkshop/scramjet/dist")));

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// ---- Wisp: 合言葉でログイン済み + 同じオリジン + IPごとの接続数制限 ----
const server = http.createServer(app);
const conns = new Map();
server.on("upgrade", (req, socket, head) => {
  const ip = clientIp(req);
  let good = /^\/wisp\/?$/.test((req.url || "").split("?")[0]) && !!PASS && okToken(getCookie(req, COOKIE));
  try { if (new URL(req.headers.origin || "").host !== req.headers.host) good = false; } catch { good = false; }
  if (good && (conns.get(ip) || 0) >= MAX_CONN) good = false;
  if (!good) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
  conns.set(ip, (conns.get(ip) || 0) + 1);
  socket.on("close", () => conns.set(ip, Math.max(0, (conns.get(ip) || 1) - 1)));
  wisp.routeRequest(req, socket, head);
});

server.listen(PORT, "0.0.0.0", () => console.log(`Lacuna OS: http://localhost:${PORT}/`));

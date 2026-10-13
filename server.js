// Lacuna OS サーバー: 画面の配信 + Wisp(中継) + 合言葉による接続制限
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

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
// ログを出さない: 標準だと、接続先のホスト名とクライアントのIPが、ログ(Renderの画面)に出てしまう
logging.set_level(logging.NONE);

// ---- 接続先の制限(環境変数で変えられる) ----
// WISP_PORTS: 使えるポート(既定 80,443。"*" で制限なし。範囲は 8000-8100 の形)
// WISP_BLOCK_HOSTS: 禁止するドメイン(カンマ区切り。example.com は、サブドメインも含む。/正規表現/ も可)
// WISP_MAX_STREAMS: 1つの接続での、同時の通信の数の上限(既定は制限なし)
// WISP_UDP=1 で、UDPを許可する(既定は禁止)
const wispPorts = (process.env.WISP_PORTS || "80,443").trim();
if (wispPorts !== "*") {
  wisp.options.port_whitelist = wispPorts.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (x.includes("-") ? x.split("-").map(Number) : Number(x)));
}
wisp.options.allow_udp_streams = process.env.WISP_UDP === "1";
const blockHosts = (process.env.WISP_BLOCK_HOSTS || "").split(",").map((x) => x.trim()).filter(Boolean);
if (blockHosts.length) {
  wisp.options.hostname_blacklist = blockHosts.map((d) => (d.startsWith("/") && d.endsWith("/") && d.length > 2 ? new RegExp(d.slice(1, -1), "i") : new RegExp("(^|\\.)" + d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i")));
}
if (Number(process.env.WISP_MAX_STREAMS) > 0) wisp.options.stream_limit_total = Number(process.env.WISP_MAX_STREAMS);

// ---- DNS: WISP_DNS=doh にすると、名前の問い合わせを、DNS over HTTPS(暗号化)で行う ----
// WISP_DOH_URL: 使うDoHのURL(既定 Cloudflare)。WISP_DNS_FALLBACK=1 で、失敗した時にRenderの標準DNSへ戻す
if (process.env.WISP_DNS === "doh") {
  const dohUrl = process.env.WISP_DOH_URL || "https://cloudflare-dns.com/dns-query";
  const ask = async (name, type) => {
    const r = await fetch(`${dohUrl}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error("doh " + r.status);
    const j = await r.json();
    const a = (j.Answer || []).find((x) => x.type === (type === "A" ? 1 : 28));
    if (!a) throw new Error("no answer");
    return a.data;
  };
  wisp.options.dns_method = async (name) => {
    try { return await ask(name, "A"); }
    catch { try { return await ask(name, "AAAA"); } catch (e) { if (process.env.WISP_DNS_FALLBACK === "1") return (await (await import("node:dns/promises")).lookup(name)).address; throw e; } }
  };
}

// ---- 認証まわり ----
let epoch = 0; // 緊急消去の時刻。これより前に発行されたログインは、無効にする
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
const makeToken = () => { const v = String(Date.now() + 7 * 864e5); return v + "." + sign(v); };
function okToken(t) {
  if (!t) return false;
  const [v, s] = t.split(".");
  if (!v || !s) return false;
  const a = Buffer.from(sign(v)), b = Buffer.from(s);
  return a.length === b.length && crypto.timingSafeEqual(a, b) && Number(v) > Date.now() && Number(v) - 7 * 864e5 >= epoch;
}
function getCookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
// IPアドレスは、そのままは保存しない(鍵つきのハッシュにして、短くする)。ログにも出さない
const clientIp = (req) => crypto.createHmac("sha256", SECRET).update((req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?").digest("base64url").slice(0, 12);

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
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  next();
});
// ---- プロキシのURLの形(環境変数で変えられる) ----
// PROXY_PREFIX: プロキシのURLの頭(既定 /~/)。PROXY_CODEC: xor(既定。鍵で読めない文字にする) か plain(URLをそのまま)。
const RESERVED = ["/api/", "/scram/", "/baremux/", "/libcurl/", "/uv/", "/wisp/", "/fonts/", "/assets/", "/healthz", "/sw.js", "/proxy-config.js", "/uv-config.js", "/robots.txt"];
function normPrefix(p, def = "/~/", other = "") {
  p = String(p || def).trim();
  if (!p.startsWith("/")) p = "/" + p;
  if (!p.endsWith("/")) p += "/";
  if (!/^\/[A-Za-z0-9_~.\/-]+\/$/.test(p) || p.includes("..") || RESERVED.some((r) => p.startsWith(r) || r.startsWith(p)) || (other && (p.startsWith(other) || other.startsWith(p)))) {
    console.warn(`[warn] プロキシのURLの頭 "${p}" は使えません。${def} を使います。`);
    return def;
  }
  return p;
}
const PROXY_PREFIX = normPrefix(process.env.PROXY_PREFIX);
const UV_PREFIX = normPrefix(process.env.UV_PREFIX, "/~u/", PROXY_PREFIX); // Ultraviolet用(Scramjetと重ならない形)
// 鍵: PROXY_KEY があればそれを使い、なければ SESSION_SECRET から作る(再起動しても変わらない)
const PROXY_KEY = process.env.PROXY_KEY || crypto.createHash("sha256").update(SECRET + ":proxy").digest("hex").slice(0, 16);
function xorCodec(key) {
  const K = JSON.stringify(key);
  return {
    encode: String.raw`e=>{if(!e)return e;var k=${K},s=encodeURIComponent(e),o="";for(var i=0;i<s.length;i++)o+=String.fromCharCode(s.charCodeAt(i)^k.charCodeAt(i%k.length));return btoa(o).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}`,
    decode: String.raw`e=>{if(!e)return e;var k=${K},s=atob(e.replace(/-/g,"+").replace(/_/g,"/")),o="";for(var i=0;i<s.length;i++)o+=String.fromCharCode(s.charCodeAt(i)^k.charCodeAt(i%k.length));return decodeURIComponent(o)}`,
  };
}
const CODECS = {
  plain: { encode: "e=>e?encodeURIComponent(e):e", decode: "e=>e?decodeURIComponent(e):e" },
  xor: xorCodec(PROXY_KEY),
};
const CODEC_NAME = CODECS[process.env.PROXY_CODEC || "xor"] ? process.env.PROXY_CODEC || "xor" : "xor"; // 既定は xor(鍵で読めなくする)。plain にすると、URLがそのまま見える
const PROXY_CONFIG_JS = "self.__PROXY=" + JSON.stringify({ prefix: PROXY_PREFIX, codec: CODECS[CODEC_NAME] }) + ";\n";
// ログインしていない人には、鍵の入っていない設定(plain)を返す
const PROXY_CONFIG_PUBLIC_JS = "self.__PROXY=" + JSON.stringify({ prefix: PROXY_PREFIX, codec: CODECS.plain }) + ";\n";
console.log(`プロキシのURL: ${PROXY_PREFIX} (UV: ${UV_PREFIX}) / 符号化: ${CODEC_NAME}`);
app.use(express.json({ limit: "1kb" }));
// Ultraviolet の設定。鍵つきの符号化は、ログインした人にだけ返す
const uvCfg = (codec) => `self.__uv$config={prefix:${JSON.stringify(UV_PREFIX)},encodeUrl:${codec.encode},decodeUrl:${codec.decode},handler:"/uv/uv.handler.js",client:"/uv/uv.client.js",bundle:"/uv/uv.bundle.js",config:"/uv-config.js",sw:"/uv/uv.sw.js"};\n`;
const UV_CONFIG_JS = uvCfg(CODECS[CODEC_NAME]), UV_CONFIG_PUBLIC_JS = uvCfg(CODECS.plain);
app.get("/uv-config.js", (q, r) => { r.setHeader("Cache-Control", "no-store"); r.type("application/javascript").send(okToken(getCookie(q, COOKIE)) ? UV_CONFIG_JS : UV_CONFIG_PUBLIC_JS); });
app.get("/proxy-config.js", (q, r) => { r.setHeader("Cache-Control", "no-store"); r.type("application/javascript").send(okToken(getCookie(q, COOKIE)) ? PROXY_CONFIG_JS : PROXY_CONFIG_PUBLIC_JS); });
app.get("/sw.js", (q, r, n) => { r.setHeader("Cache-Control", "no-cache"); n(); });

app.use("/api/", (q, r, n) => { r.setHeader("Cache-Control", "no-store"); n(); });
app.get("/robots.txt", (q, r) => r.type("text/plain").send("User-agent: *\nDisallow: /\n")); // 検索エンジンに載せない
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
// 緊急消去: ブラウザの保存データ(IndexedDB・キャッシュ・Cookieなど)を消す指示を返し、これまでのログインをすべて無効にする
app.post("/api/panic", (req, res) => {
  if (!okToken(getCookie(req, COOKIE))) return res.status(401).json({ ok: false });
  epoch = Date.now();
  res.setHeader("Clear-Site-Data", '"cache", "cookies", "storage"');
  res.setHeader("Set-Cookie", `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${req.secure ? "; Secure" : ""}`);
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
// libcurl はブラウザ用の部品なので、パッケージの dist フォルダをそのまま配る
const pkgDist = (name) => path.join(__dirname, "node_modules/@mercuryworkshop", name, "dist");
await mount("/libcurl/", [], () => pkgDist("libcurl-transport"));
// フォントは自分のサーバーから配る(外部サイトだと、cross-origin isolationで読み込めないことがあるため)
const fontDir = (name) => path.join(__dirname, "node_modules/@fontsource", name);
await mount("/fonts/zen-maru/", [], () => fontDir("zen-maru-gothic"));
await mount("/fonts/jetbrains/", [], () => fontDir("jetbrains-mono"));
await mount("/uv/", ["@titaniumnetwork-dev/ultraviolet"], (m) => m.uvPath || (m.default && m.default.uvPath));
await mount("/scram/", ["@mercuryworkshop/scramjet/path", "@mercuryworkshop/scramjet"], (m) => m.scramjetPath || (fs.existsSync(dist) ? dist : null));

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

// 古い記録を、定期的に消す(メモリの中だけの記録)
setInterval(() => {
  for (const [k, a] of tries) { const f = recent(a); if (f.length) tries.set(k, f); else tries.delete(k); }
  for (const [k, v] of conns) if (!v) conns.delete(k);
}, 600000).unref();
server.listen(PORT, "0.0.0.0", () => console.log(`Lacuna OS: http://localhost:${PORT}/`));

// Scramjet のService Worker
// 注意: プロキシ用のURL(/scramjet/ 以下)だけを処理する。それ以外は、そのまま通す。
// (全部の通信で設定を読もうとすると、準備前に失敗して、サイト全体が壊れる)
importScripts("/scram/scramjet.all.js");
const { ScramjetServiceWorker } = $scramjetLoadWorker();

const PREFIX = "/scramjet/";
let scramjet = null; // 最初のプロキシ通信まで作らない(作ると、bare-muxの接続待ちが始まるため)
let shields = null;  // 広告・トラッカーのブロック(null = まだ読んでいない)

// ブロックするドメイン(広告・計測・トラッカーの代表的なもの)
const BLOCK = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "googletagmanager.com",
  "googletagservices.com", "google-analytics.com", "adservice.google.com", "connect.facebook.net",
  "static.ads-twitter.com", "adnxs.com", "taboola.com", "outbrain.com", "criteo.com",
  "scorecardresearch.com", "hotjar.com", "quantserve.com", "amazon-adsystem.com", "moatads.com",
];

function realUrl(u) { try { return decodeURIComponent(u.pathname.slice(PREFIX.length)); } catch { return u.pathname; } }
function isBlocked(real) {
  try { const h = new URL(real).hostname; return BLOCK.some((d) => h === d || h.endsWith("." + d)); } catch { return false; }
}
async function shieldsOn() {
  if (shields === null) {
    try { const r = await (await caches.open("lacuna-cfg")).match("/__shields"); shields = r ? (await r.text()) !== "0" : true; }
    catch { shields = true; }
  }
  return shields;
}
async function note(m) {
  try { (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).forEach((c) => c.postMessage(m)); } catch {}
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));
self.addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.type === "shields") {
    shields = !!d.on;
    caches.open("lacuna-cfg").then((c) => c.put("/__shields", new Response(shields ? "1" : "0"))).catch(() => {});
  }
});

async function handle(event) {
  const url = new URL(event.request.url);
  if (url.origin === location.origin && url.pathname.startsWith(PREFIX)) {
    const real = realUrl(url);
    const method = event.request.method, dest = event.request.destination || "";
    try {
      if ((await shieldsOn()) && isBlocked(real)) {
        note({ type: "blocked", url: real });
        return new Response("", { status: 204 });
      }
      if (!scramjet) scramjet = new ScramjetServiceWorker();
      await scramjet.loadConfig();
      if (scramjet.route(event)) {
        const t0 = Date.now();
        const res = await scramjet.fetch(event);
        note({ type: "net", url: real, status: res.status, ms: Date.now() - t0, dest, method });
        return res;
      }
    } catch (e) {
      console.error("[sw] scramjet error:", e);
      note({ type: "net", url: real, status: 502, ms: 0, dest, method, error: String(e && e.message || e) });
      return new Response("プロキシの準備ができていません: " + (e && e.message), {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }
  return fetch(event.request);
}
self.addEventListener("fetch", (e) => e.respondWith(handle(e)));

// Scramjet のService Worker
// 注意: プロキシ用のURL(/scramjet/ 以下)だけを処理する。
// それ以外(自分のサイトの画像・フォント・API)は、そのまま通す。
// (全部の通信で設定を読もうとすると、準備前に失敗して、サイト全体が壊れる)
importScripts("/scram/scramjet.all.js");
const { ScramjetServiceWorker } = $scramjetLoadWorker();

const PREFIX = "/scramjet/";
let scramjet = null; // 最初のプロキシ通信まで作らない(作ると、bare-muxの接続待ちが始まるため)

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));

async function handle(event) {
  const url = new URL(event.request.url);
  if (url.origin === location.origin && url.pathname.startsWith(PREFIX)) {
    try {
      if (!scramjet) scramjet = new ScramjetServiceWorker();
      await scramjet.loadConfig();
      if (scramjet.route(event)) return await scramjet.fetch(event);
    } catch (e) {
      console.error("[sw] scramjet error:", e);
      return new Response("プロキシの準備ができていません: " + e.message, {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }
  return fetch(event.request);
}
self.addEventListener("fetch", (e) => e.respondWith(handle(e)));

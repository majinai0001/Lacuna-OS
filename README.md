# Lacuna OS サーバー

画面(Lacuna OS)の配信、Wisp(中継)、合言葉による接続制限を1つのNodeサーバーでまとめたものです。

## Renderに載せる手順
1. このフォルダの中身を、GitHubの新しいリポジトリに入れます(`package-lock.json` も入れる)。
2. Renderで「New」→「Blueprint」を選び、そのリポジトリを指定します。`render.yaml` が読まれます。
   手動なら「Web Service」で、Build Command は `npm install`、Start Command は `node server.js` です。
3. 環境変数 `ACCESS_PASSPHRASE` に、長い合言葉を入れます(これがないと中継は動きません)。
   `SESSION_SECRET` は、Blueprintなら自動で作られます。
4. デプロイ後、`https://○○.onrender.com/unlock.html` で合言葉を入れます。

## uptimeボット
監視するURLは `https://○○.onrender.com/healthz` です。間隔は5分にします。

## 入っている安全対策
- Wispに接続できるのは、合言葉でログイン済みのブラウザだけです(Cookie: HttpOnly / SameSite=Strict / Secure)。
- WebSocketは、同じサイトからの接続だけを受け付けます。
- 合言葉の総当たりは、IPごとに10分で5回、全体で10分に50回までです。
- 1つのIPが同時に張れるWisp接続は20までです(`WISP_MAX_CONN` で変更できます)。
- 内部ネットワーク(ループバック、プライベートIP)への接続を禁止しています。
- HSTSなどのセキュリティヘッダーを付けています。

## まだ入っていないもの
- 通信量やポートの制限。Renderの無料枠は通信量が少ないので、あとで上限を付けます。
- 本物のIP判定。Renderの手前のプロキシによっては、IPごとの制限が粗くなります。

## ローカルで試す
```
npm install
ACCESS_PASSPHRASE=好きな合言葉 node server.js
```

## フォントと画像
- 画面は Zen Maru Gothic、ターミナルは JetBrains Mono です。`npm install` で `@fontsource` から入り、`/fonts/` から配られます(外部サイトは使いません)。
- 壁紙とアイコンは `public/assets/` にあります。
- チャット用の1ファイル版は `python3 build_single.py public/index.html out.html` で作れます(画像を埋め込み、フォントはGoogle Fontsに切り替えます)。

## ブラウザアプリ(Scramjet)
- Lacuna OSの「ブラウザ」アプリは、Scramjet + libcurl + Wisp でサイトを開きます。サーバー版(このzip)でだけ動きます。
- 使うには、先に合言葉でログインが必要です。ブラウザアプリを開くと、合言葉の入力欄が出ます。
- Service Worker は `public/sw.js` です。ブラウザアプリを初めて開いた時に登録されます。
- **まだ実機のブラウザで通した確認はしていません。** 動かない時は、ブラウザの開発者ツールのコンソールを見てください。

## cross-origin isolation(QEMU Wasm用)
- 既定では、COOP/COEPヘッダーを付けません。ブラウザアプリ(iframe)と両立しにくいためです。
- QEMU Wasmを試す時だけ、環境変数 `ISOLATION=1` を付けて起動します。

## ライセンス
- Scramjet、libcurl-transport、bare-mux などは、AGPL-3.0です。改変したものをネットで公開する場合は、ソースの提供が必要になります。このzipは、改変せずに配信しています。

## バージョンについて(重要)
- `package.json` は、動作を確認したバージョンに固定しています(Scramjet 1.1.0 など)。`package-lock.json` も、一緒に入れてください。
- Scramjetの `alpha`(2.x)には変えないでください。ファイル名もAPIも違い(`scramjet.all.js` がなくなります)、`sw.js` と `index.html` の書き方が合いません。
- 上げたい時は、すべて同じ時期のバージョンにそろえて、`sw.js` と `index.html` も書き直す必要があります。

## 部品の組み合わせ(重要)
- `bare-mux 2.1.9` には、`libcurl-transport 1.5.2` を組み合わせます。`libcurl-transport 2.x` は、ヘッダーの渡し方が違い、`headers is not iterable` というエラーになります。
- `epoxy-transport` は使っていないので、外しました。

## ブラウザアプリの機能
- タブ(最大8)、戻る・進む・更新、ホーム、ブックマーク(星)、履歴、設定ページ(`lacuna://settings`)。履歴・ブックマーク・設定は、ユーザーごとに暗号化して `~/.config/browser.json` に保存されます。
- シールド: 既知の広告・トラッカーのドメインへの通信を、`public/sw.js` で止めます(一覧は `BLOCK`)。
- 開発者ツール(F12、またはメニュー): コンソール(ページのconsole.log、エラー、JavaScriptの実行)、ネットワーク(プロキシ経由の通信と状態コード)、要素(HTML)。

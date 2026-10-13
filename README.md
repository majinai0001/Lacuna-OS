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

## ファイルアプリとエディター
- 「ファイル」アプリは、仮想ファイルシステム(暗号化して保存)を、エクスプローラー風に操作します。新規フォルダー・新規テキスト、名前の変更、切り取り・コピー・貼り付け、削除(2回押して確定)、プロパティ(権限の変更)ができます。
- ファイルを開くと、「エディター」で編集できます(Ctrl+Sか、保存ボタン)。
- 権限(所有者とrwx)は、ターミナルと共通です。userは `/root` に入れません。

## プロキシのURLを変える(環境変数)
- `PROXY_PREFIX`: プロキシのURLの頭です。既定は `/~/` です(例: `/~/https%3A%2F%2Fexample.com%2F`)。`/s/` や `/a/b/` などに変えられます。`/api/` `/scram/` `/baremux/` `/libcurl/` `/wisp/` `/fonts/` `/assets/` で始まるものは使えません。
- `PROXY_CODEC`: `xor`(既定。移動先のURLを、鍵で読めない文字列にします。**私は実機で未確認です**)か、`plain`(移動先のURLが、そのまま見えます)。もし `xor` で動かなければ、Renderの環境変数に `PROXY_CODEC` = `plain` を入れると、元に戻ります。
- 変えたら、Renderの「Environment」で設定して、再デプロイします。ブラウザは、ページを2回再読み込みしてください。
- 注意: `/scram/` `/baremux/` `/libcurl/` `/wisp/` というパスの名前は、変わりません。
- `PROXY_KEY`(省略可): `xor` の鍵です。省略すると、`SESSION_SECRET` から自動で作られます(再起動しても変わりません)。`/proxy-config.js`(鍵を含む)は、合言葉でログインした人にしか返しません。

## ログと記録を残さない
- Wispは、標準だと、接続先のホスト名とクライアントのIPを、ログ(Renderの画面)に書き出します。このサーバーは、ログを止めています(`logging.set_level(NONE)`)。
- 合言葉の試行回数などの記録は、IPをそのまま持たず、鍵つきのハッシュにして、メモリの中だけに置きます。古いものは、定期的に消します。
- 検索エンジンに載らないよう、`robots.txt` と `X-Robots-Tag` を付けています。
- ブラウザアプリの履歴は、既定で保存しません(設定でオンにできます)。
- Render側のログ(アクセス元のIPなど、プラットフォームが取るもの)は、こちらでは消せません。

## 緊急消去
- 次のどれでも実行できます。いずれも、保存データ(IndexedDB、キャッシュ、Cookie、Service Worker)を消して、最初の設定画面に戻します。
  - スタートメニューの電源ボタン →「緊急消去」(2回押して確定)
  - 設定 →「システム」→「緊急消去」(2回押して確定)
  - ロック画面の「緊急消去」(2回押して確定)
  - キーボードで、`Shift + Esc` を、1.5秒以内に3回
- サーバーにも知らせ、これまでのログインを、すべて無効にします(`/api/panic`)。
- 注意: サーバーの再起動で、無効にした記録は消えます。完全に無効にするには、Renderの `SESSION_SECRET` を、新しい値に変えてください。
- 注意: ブラウザ以外の場所(Renderのデプロイ履歴、GitHub、Renderのログ)のデータは、消えません。

## Ultraviolet(2つ目のプロキシ)と、接続の制限・DNS(環境変数)
- Ultraviolet 3.2.10(MIT)を、`/uv/` から配ります。URLの頭は `UV_PREFIX`(既定 `/~u/`)です。Scramjetの `PROXY_PREFIX` と重なる値は使えません(使うと、既定に戻ります)。
- **画面側(ブラウザアプリでエンジンを切り替える部分)は、まだ入っていません。** いまは、サーバーが用意しただけです。
- `WISP_PORTS`: 使えるポート。既定は `80,443` だけです(SSHやメールなどの、悪用されやすいポートを止めます)。`*` で制限なし、`8000-8100` のように範囲も書けます。
- `WISP_UDP=1`: UDPを許可します(既定は禁止)。
- `WISP_BLOCK_HOSTS`: 禁止するドメイン(カンマ区切り)。`example.com` と書くと、サブドメインも止めます。`/正規表現/` も使えます。
- `WISP_MAX_STREAMS`: 1つの接続での、同時の通信の数の上限(既定は制限なし)。
- `WISP_DNS=doh`: 名前の問い合わせを、DNS over HTTPSで行います(既定は、Renderの標準DNS)。`WISP_DOH_URL`(既定 Cloudflare)、`WISP_DNS_FALLBACK=1`(失敗した時だけ、標準DNSに戻す)も使えます。

# public/index.html の assets/ 参照を data: URI に置き換えて、1ファイルのHTMLを作る
import re, base64, sys
src, out = sys.argv[1], sys.argv[2]
mime = {'svg': 'image/svg+xml', 'webp': 'image/webp', 'png': 'image/png'}
def sub(m):
    path = m.group(0)
    data = base64.b64encode(open('public/' + path, 'rb').read()).decode()
    return 'data:%s;base64,%s' % (mime[path.rsplit('.', 1)[1]], data)
GF = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
      '<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Zen+Maru+Gothic:wght@400;500;700&display=swap" rel="stylesheet">\n')
html = open(src, encoding='utf-8').read()
html = re.sub(r'<!--fonts-local-->.*?<!--/fonts-local-->\n', lambda m: GF, html, flags=re.S)
html = re.sub(r'assets/[A-Za-z0-9_./-]+\.(?:svg|webp|png)', sub, html)
open(out, 'w', encoding='utf-8').write(html)
print('built', out, len(html), 'bytes; leftover assets/ refs:', html.count('assets/'))

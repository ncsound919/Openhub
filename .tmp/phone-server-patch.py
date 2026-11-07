import sys

P = '/data/data/com.termux/files/home/openhub/server.ts'
src = open(P, encoding='utf-8').read()

anchor_import = "import { createOpencodeProxyRouter } from './src/routes/opencodeProxy.js';"
anchor_mount = "app.use('/api', createOpencodeProxyRouter({ authMiddleware: auth.middleware() }));"

add_import = anchor_import + "\nimport { createDshProxyRouter } from './src/routes/dshProxy.js';"
add_mount = anchor_mount + "\n  app.use('/api', createDshProxyRouter({ authMiddleware: auth.middleware() }));"

if 'createDshProxyRouter' in src:
    print('ALREADY-PATCHED');
    sys.exit(0)
if src.count(anchor_import) != 1 or src.count(anchor_mount) != 1:
    print(f'ANCHOR-FAIL import={src.count(anchor_import)} mount={src.count(anchor_mount)}')
    sys.exit(1)

src = src.replace(anchor_import, add_import).replace(anchor_mount, add_mount)
open(P, 'w', encoding='utf-8').write(src)
print('PATCHED-OK')

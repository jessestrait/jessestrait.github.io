#!/usr/bin/env python3
"""Static audit for this repo — the checks that don't need a browser.

Run it before every deploy:

    python3 tools/debug/audit.py

Each check is here because shipping without it cost a round of "it's
still broken" that was never the code at all:

  goatcounter   CLAUDE.md requires the tracking script on every page,
                shared site code `jesserstrait`. Easy to forget on a new
                page and invisible when missing.
  cachebust     GitHub Pages serves HTML and JS with independent
                max-age=600. Edit city3d.js without bumping its ?v= and
                readers get new HTML against old JS for ten minutes,
                which presents as any bug you like. This flags an asset
                modified against HEAD whose version tag did not move.
  swversion     Same trap, one level up: the service worker holds the
                shell until VERSION changes. A shell file edited with
                VERSION untouched is a stale page for returning readers.
  deadrefs      A src= or href= pointing at a file that isn't there.
  wrangler      `npx wrangler deploy` from the repo root publishes .git/
                — the whole history, public. There must be no wrangler
                config at the root to make that possible; deploys are
                `cd workers/capmetro && npx wrangler deploy`.
  secrets       An API key committed to a tracked file.
"""
import hashlib, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
fails, warns = [], []

def sh(*a):
    return subprocess.run(a, cwd=ROOT, capture_output=True, text=True).stdout

def html_files():
    out = []
    for d, dirs, fs in os.walk(ROOT):
        dirs[:] = [x for x in dirs if x not in
                   ('.git', '.claude', 'node_modules', '.wrangler')]
        out += [os.path.join(d, f) for f in fs if f.endswith('.html')]
    return sorted(out)

def rel(p):
    return os.path.relpath(p, ROOT)

# ── goatcounter ──────────────────────────────────────────────────────
GC = 'jesserstrait.goatcounter.com/count'
for p in html_files():
    src = open(p, encoding='utf-8', errors='replace').read()
    if 'data-goatcounter' not in src:
        fails.append(f'{rel(p)}: no GoatCounter script (CLAUDE.md requires it)')
    elif GC not in src:
        m = re.search(r'data-goatcounter="([^"]+)"', src)
        fails.append(f'{rel(p)}: GoatCounter points at {m.group(1) if m else "?"}, '
                     f'not the shared {GC}')
    elif src.rfind('data-goatcounter') < src.rfind('</body>') - 4000:
        warns.append(f'{rel(p)}: GoatCounter script is far above </body>')

# ── cachebust ────────────────────────────────────────────────────────
# Files the working tree has changed relative to HEAD.
dirty = set(x for x in sh('git', 'diff', 'HEAD', '--name-only').split('\n') if x)
VER_RE = r'(?:src|href)="([^"?#]+)\?v=([^"&]+)"'

def versions_in(text, hrel):
    """{asset path: version string} for every ?v= reference in one page."""
    out = {}
    for m in re.finditer(VER_RE, text):
        out[os.path.normpath(os.path.join(os.path.dirname(hrel), m.group(1)))] = m.group(2)
    return out

for p in html_files():
    hrel = rel(p)
    now = versions_in(open(p, encoding='utf-8', errors='replace').read(), hrel)
    # Compare the version STRING against HEAD, not the mtime of the page.
    # This used to ask whether the HTML was also modified, which meant any
    # unrelated edit to index.html silenced the check for every asset on it
    # — and it did, on the commit that added the arrest metrics.
    head = versions_in(sh('git', 'show', 'HEAD:' + hrel), hrel)
    for asset, ver in now.items():
        if asset in dirty and head.get(asset) == ver:
            fails.append(f'{hrel}: {os.path.basename(asset)} is modified but its '
                         f'?v={ver} is unchanged since HEAD — readers will get '
                         f'new HTML on old JS')

# ── swversion ────────────────────────────────────────────────────────
# Only what VERSION actually gates. This used to list index.html and
# city3d.js and warn that readers would "hold the old shell" — neither is
# true: the worker fetches the HTML network-first with cache:'reload', and
# it has no rule for city3d.js at all, so that one is covered by the
# cachebust check above and nothing else.
SHELL_FILES = ('atx/manifest.json',)
sw = os.path.join(ROOT, 'atx', 'sw.js')
if os.path.exists(sw):
    src = open(sw, encoding='utf-8').read()
    ver = re.search(r"const VERSION = '([^']+)'", src)
    changed = [f for f in SHELL_FILES if f in dirty]
    if changed and 'atx/sw.js' not in dirty:
        warns.append(f'atx/sw.js: VERSION still {ver.group(1) if ver else "?"} while '
                     f'{", ".join(changed)} changed — that file is precached, so '
                     f'returning readers keep the old copy until VERSION moves')

# ── deadrefs ─────────────────────────────────────────────────────────
for p in html_files():
    src = open(p, encoding='utf-8', errors='replace').read()
    for m in re.finditer(r'(?:src|href)="(?!https?:|//|data:|#|mailto:)([^"?#]+)', src):
        ref = m.group(1)
        # href="' + esc(url) + '" is JS assembling a URL, not a path.
        if re.search(r"""[+'`${} \t]""", ref):
            continue
        t = os.path.normpath(os.path.join(os.path.dirname(p), ref))
        if not ref.endswith('/') and not os.path.exists(t):
            fails.append(f'{rel(p)}: references {m.group(1)}, which does not exist')

# ── wrangler ─────────────────────────────────────────────────────────
for name in ('wrangler.toml', 'wrangler.json', 'wrangler.jsonc'):
    if os.path.exists(os.path.join(ROOT, name)):
        fails.append(f'{name} at the repo root — `npx wrangler deploy` here would '
                     f'publish .git/ to the internet. Deploy from workers/capmetro.')

# ── secrets ──────────────────────────────────────────────────────────
PATTERNS = [
    (r'\b[A-Za-z0-9]{32}\b', 'a 32-char token (TomTom keys look like this)'),
    (r'(?i)\b(api[_-]?key|secret|token)\s*[:=]\s*["\'][A-Za-z0-9_\-]{16,}', 'an inline credential'),
]
tracked = [f for f in sh('git', 'ls-files').split('\n')
           if f and f.rsplit('.', 1)[-1] in ('js', 'html', 'py', 'yml', 'yaml', 'json', 'toml')]
for f in tracked:
    try:
        src = open(os.path.join(ROOT, f), encoding='utf-8', errors='replace').read()
    except OSError:
        continue
    for pat, what in PATTERNS:
        for m in re.finditer(pat, src):
            line = src[:m.start()].count('\n') + 1
            ctx = src.splitlines()[line - 1].strip()[:90]
            # sha hashes, integrity attrs and hex colours are not secrets
            if 'integrity=' in ctx or 'sha256-' in ctx or 'sha384-' in ctx:
                continue
            # An `audit-ok:` note on the line or in the three lines above
            # it marks a value that is public on purpose — a browser map
            # key, say — with the reason written next to the value.
            near = '\n'.join(src.splitlines()[max(0, line - 4):line])
            if 'audit-ok' in near:
                continue
            warns.append(f'{f}:{line}: possibly {what} — {ctx}')

# ── report ───────────────────────────────────────────────────────────
for w in warns:
    print(f'  warn  {w}')
for f in fails:
    print(f'  FAIL  {f}')
print(f'\n{len(html_files())} pages checked · {len(fails)} failures · {len(warns)} warnings')
sys.exit(1 if fails else 0)

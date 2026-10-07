#!/usr/bin/env python3
"""Generate the dsh-workbuddy-bridge model catalog from the live /v3/config
endpoint (CLI UA for the full model list, IDE UA for promotions/badges).

Usage: python gen_models.py <auth.json path>
Outputs the llm-pi-ai `models:` YAML block to stdout and updates index.js DEFAULTS.
"""
import json, io, sys, re, urllib.request, time

AUTH = json.load(io.open(sys.argv[1], encoding='utf-8'))
BASE = 'https://copilot.tencent.com'

def fetch(ua):
    req = urllib.request.Request(BASE + '/v3/config', headers={
        'accept': 'application/json, text/plain, */*',
        'x-requested-with': 'XMLHttpRequest',
        'authorization': 'Bearer ' + AUTH['accessToken'],
        'x-user-id': AUTH.get('uid', ''),
        'x-domain': 'copilot.tencent.com',
        'x-product': 'SaaS',
        'user-agent': ua,
        'x-codebuddy-request': '1',
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

ide = fetch('CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0')
cli = fetch('CLI/2.137.1 CodeBuddy/2.137.1')

# merge models by id: CLI list is the superset for chat models; keep real caps
by_id = {}
for m in ide['data'].get('models', []) + cli['data'].get('models', []):
    by_id.setdefault(m['id'], m)

# promotions from either payload (IDE UA carries them)
promos = {}
for src in (ide, cli):
    for p in src['data'].get('modelPromotions', []) or []:
        if not p.get('enabled'):
            continue
        for mid in p.get('modelIds', []):
            # highest priority wins per model
            if mid not in promos or p.get('priority', 0) > promos[mid].get('priority', 0):
                promos[mid] = p

NON_CHAT = ('codewise-', 'nes-gf', 'hunyuan-image')
SKIP = {'default', 'auto'}  # routers/tiers, not real models

def badge_of(mid, base_mult):
    p = promos.get(mid)
    if not p:
        return ''
    label = (p.get('badge') or {}).get('label', '')
    disc = p.get('discount') or {}
    factor = disc.get('factor')
    extra = ''
    if factor == 0:
        extra = '限时免费'
    elif label:
        extra = label
    sched = p.get('schedule') or {}
    daily = sched.get('daily') or []
    windows = '/'.join(f"{w.get('start')}-{w.get('end')}" for w in daily) if daily else ''
    parts = [x for x in (extra, f'{windows}' if windows and extra and extra != '限时免费' else '') if x]
    return f"{' · '.join(parts)}" if parts else ''

seen_names = {}
lines = []
for mid, m in sorted(by_id.items()):
    if any(mid.startswith(x) for x in NON_CHAT) or mid in SKIP:
        continue
    if m.get('type') not in (None, 'chat'):
        continue
    mult = (m.get('credits') or '').replace(' credits', '').strip()
    name = m.get('name') or mid
    # deduplicate display names (hy3/hy3-x, hy4-preview/hy4-preview-x)
    key = name
    seen_names[key] = seen_names.get(key, 0) + 1
    if seen_names[key] > 1:
        suffix = mid.split('-')[-1]
        name = f"{name}-{suffix.upper()}" if len(suffix) <= 2 else f"{name} ({mid})"
    badge = badge_of(mid, mult)
    disp = f"{name} ({mult})" if mult and mult != 'x0.00' else (f"{name} (free)" if mult == 'x0.00' else name)
    if badge:
        disp = f"{disp} · {badge}"
    ctx = min(int(m.get('maxInputTokens') or 200000), 400000)
    out = min(int(m.get('maxOutputTokens') or 32000), 131072)
    inp = '["text", "image"]' if m.get('supportsImages') else '["text"]'
    lines.append(f"""          - id: {mid}
            name: {disp}
            input: {inp}
            contextWindow: {ctx}
            maxTokens: {out}""")

block = '\n'.join(lines)
print(block, file=sys.stderr)

# 1. repo bundle patch
repo = r'C:\Users\17619\Documents\Qoder\2026-10-07\53d3b1a0\workbuddy_to_deepseek\cordis.patch.yml'
c = io.open(repo, encoding='utf-8').read()
c = re.sub(r'(        baseURL: http://127\.0\.0\.1:37321/v1\n        models:\n)(?:.*\n)*?(?=\S|\Z)',
           lambda mm: mm.group(1) + block + '\n', c, count=1)
io.open(repo, 'w', encoding='utf-8').write(c)

# 2. user's live profile patch (workbuddy section only)
p = r'C:\Users\17619\.dsh\profiles\desktop\cordis.patch.yml'
c = io.open(p, encoding='utf-8').read()
i = c.find('      workbuddy:')
j = c.find('      siliconflow:')
assert i > 0 and j > i, (i, j)
seg = c[i:j]
head_m = re.search(r'(displayName:.*\n\s*apiKeyEnv:.*\n\s*api:.*\n\s*baseURL:.*\n)', seg)
assert head_m, seg[:300]
newseg = '      workbuddy:\n' + head_m.group(1) + '        models:\n' + block + '\n'
c = c[:i] + newseg + c[j:]
io.open(p, 'w', encoding='utf-8').write(c)

# 3. index.js DEFAULTS.models
js = r'C:\Users\17619\Documents\Qoder\2026-10-07\53d3b1a0\workbuddy_to_deepseek\index.js'
ids = sorted(by_id.keys())
src = io.open(js, encoding='utf-8').read()
src = re.sub(r"  models: \[\n(?:    .*\n)+  \],",
             "  models: [\n    " + ", ".join(f"'{x}'" for x in ids) + "\n  ],", src, count=1)
io.open(js, 'w', encoding='utf-8').write(src)
print(f"OK: {len(lines)} chat models written; ids: {len(ids)}", file=sys.stderr)

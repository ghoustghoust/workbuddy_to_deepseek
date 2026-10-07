#!/usr/bin/env python3
"""Generate the dsh-workbuddy-bridge model catalog from the live /v3/config
endpoint (CLI UA for models, IDE UA for promotions).

Only the models currently listed by the official desktop client are kept.
Display names carry the CURRENT effective price (Asia/Shanghai), e.g.
  GLM-5.2 (x0.79·夜间23:00-7:50半价x0.40)
  Hy3 (现免费·至11-01)

Usage: python scripts/gen_models.py <path-to-auth.json>
"""
import json, io, sys, re, urllib.request, datetime

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

# models currently listed by the official desktop picker (2026-10-07)
ACTIVE = ['hy4-preview', 'hy3', 'space-bunny', 'deepseek-v4.1-flash', 'glm-5.3',
          'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3',
          'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro']

by_id = {}
for m in ide['data'].get('models', []) + cli['data'].get('models', []):
    by_id.setdefault(m['id'], m)
promos = {}
for src in (ide, cli):
    for p in src['data'].get('modelPromotions', []) or []:
        if p.get('enabled'):
            for mid in p.get('modelIds', []):
                promos.setdefault(mid, []).append(p)

def now_sh():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))

def promo_active(p, dsh):
    sched = p.get('schedule') or {}
    now = datetime.datetime.now(datetime.timezone.utc)
    try:
        if sched.get('validFrom') and now < datetime.datetime.fromisoformat(sched['validFrom']): return False
        if sched.get('validUntil') and now > datetime.datetime.fromisoformat(sched['validUntil']): return False
    except ValueError:
        pass
    daily = sched.get('daily') or []
    if not daily: return True
    minutes = dsh.hour * 60 + dsh.minute
    for w in daily:
        def mm(x):
            h, m = str(x).split(':')
            return int(h) * 60 + int(m)
        s, e = mm(w.get('start')), mm(w.get('end'))
        if s <= e:
            if s <= minutes <= e: return True
        elif minutes >= s or minutes <= e:
            return True
    return False

def until_tag(p):
    vu = (p.get('schedule') or {}).get('validUntil')
    if vu:
        try:
            d = datetime.datetime.fromisoformat(vu).astimezone(datetime.timezone(datetime.timedelta(hours=8)))
            return f"至{d.month}-{d.day}"
        except ValueError:
            return ''
    return ''

def price_tag(mid, base):
    """Current-effective-price name suffix for this model."""
    dsh = now_sh()
    best = None
    for p in promos.get(mid, []):
        if promo_active(p, dsh):
            if not best or p.get('priority', 0) > best.get('priority', 0):
                best = p
    if not best:
        # nothing active now — mention upcoming scheduled promos
        upcoming = next((p for p in promos.get(mid, []) if (p.get('discount') or {}).get('factor') is not None), None)
        if upcoming:
            disc = upcoming['discount']
            win = '/'.join(f"{w.get('start')}-{w.get('end')}" for w in (upcoming.get('schedule', {}).get('daily') or []))
            label = (upcoming.get('badge') or {}).get('label', '')
            if disc.get('factor') == 0:
                return f"x{base:g}·{win}免费" if win else f"x{base:g}·{label}"
            eff = round(base * disc['factor'], 3)
            return f"x{base:g}·{win}x{eff:g}" if win else f"x{base:g}·{label}"
        return f"x{base:g}"
    disc = best.get('discount') or {}
    label = (best.get('badge') or {}).get('label', '')
    win = '/'.join(f"{w.get('start')}-{w.get('end')}" for w in (best.get('schedule', {}).get('daily') or []))
    ut = until_tag(best)
    factor = disc.get('factor')
    if factor == 0:
        return f"现免费{('·' + ut) if ut else ''}"
    if factor is not None:
        eff = round(base * factor, 3)
        return f"现x{eff:g}{('·' + ut) if ut else ''}·原x{base:g}" + (f"·{win}" if win else "")
    # badge-only: price unchanged, explain the offer
    if '高峰' in label:
        return f"x{base:g}·高峰时段(9-12/14-18点)恢复原价"
    tag = f"x{base:g}·{label}" + (f"·{ut}" if ut else '')
    return tag

lines = []
ids = []
for mid in ACTIVE:
    m = by_id.get(mid)
    if not m:
        print(f"WARN: {mid} missing from catalog, skipped", file=sys.stderr)
        continue
    ids.append(mid)
    base = re.search(r'x([\d.]+)', m.get('credits') or '')
    base = float(base.group(1)) if base else None
    tag = price_tag(mid, base) if base is not None else ''
    disp = f"{m.get('name') or mid} ({tag})" if tag else (m.get('name') or mid)
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

import yaml

def models_objs():
    """Build the models list as Python objects for structured YAML writes."""
    out = []
    for mid in ids:
        m = by_id[mid]
        base = re.search(r'x([\d.]+)', m.get('credits') or '')
        base = float(base.group(1)) if base else None
        tag = price_tag(mid, base) if base is not None else ''
        disp = f"{m.get('name') or mid} ({tag})" if tag else (m.get('name') or mid)
        out.append({
            'id': mid,
            'name': disp,
            'input': (['text', 'image'] if m.get('supportsImages') else ['text']),
            'contextWindow': min(int(m.get('maxInputTokens') or 200000), 400000),
            'maxTokens': min(int(m.get('maxOutputTokens') or 32000), 131072),
        })
    return out

def write_yaml(path, doc, header=None):
    text = (header + '\n' if header else '') + yaml.safe_dump(doc, allow_unicode=True, sort_keys=False, width=4096)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(text)

# 1. repo bundle patch
repo = r'C:\Users\17619\Documents\Qoder\2026-10-07\53d3b1a0\workbuddy_to_deepseek\cordis.patch.yml'
doc = yaml.safe_load(io.open(repo, encoding='utf-8'))
for entry in doc:
    if entry.get('id') == 'llm-pi-ai':
        entry['config']['providers']['workbuddy']['models'] = models_objs()
write_yaml(repo, doc)

# 2. user's live profile patch
p = r'C:\Users\17619\.dsh\profiles\desktop\cordis.patch.yml'
doc = yaml.safe_load(io.open(p, encoding='utf-8'))
for entry in doc:
    if entry.get('id') == 'llm-pi-ai':
        entry['config']['providers']['workbuddy']['models'] = models_objs()
write_yaml(p, doc)

# 3. index.js DEFAULTS.models
js = r'C:\Users\17619\Documents\Qoder\2026-10-07\53d3b1a0\workbuddy_to_deepseek\index.js'
src = io.open(js, encoding='utf-8').read()
src = re.sub(r"  models: \[[^\]]*\],",
             "  models: [\n    " + ", ".join(f"'{x}'" for x in ids) + "\n  ],", src, count=1)
io.open(js, 'w', encoding='utf-8').write(src)
print(f"OK: {len(lines)} models", file=sys.stderr)

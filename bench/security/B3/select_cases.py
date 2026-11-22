"""Step 2: draw the frozen sample and fetch its page text.
  uv run --with pyarrow --with huggingface_hub python -I select_cases.py <data dir>
Reads data/train-meta.parquet (fetch_meta.py), keeps exfiltration attacks that do not come from the original BrowseSafe,
one per source injection, draws 150 by attack_type x page language (seeded), adds their controls, fetches content_markdown
and content_html for those row groups only (train split, exact byte ranges), writes cases.json + cases.sha256.
A rerun with the fetched text already there (data/content.parquet) downloads nothing and must give the same sha256."""
import hashlib, html, json, os, random, re, sys
from collections import Counter, defaultdict
import pyarrow as pa, pyarrow.parquet as pq

SEED = 20261119
N = 150
out = sys.argv[1]
rows = pq.read_table(os.path.join(out, "train-meta.parquet")).to_pylist()
by_id = {r["entry_id"]: r for r in rows}
pair = lambda r: r["entry_id"].split("_")[0]

# No field marks the pairs inherited from the original BrowseSafe. The train files hold two populations in file order
# (README.md says how they differ): block A, every row before the first pair numbered 10700 or more, carries BrowseSafe's
# signatures; block B is the rest. Excluded: the whole of block A, and any block B page whose injection (same detection
# timestamp) also appears in block A.
FIRST_B_ID = 10700
first_b = next(i for i, r in enumerate(rows) if int(pair(r)) >= FIRST_B_ID)
block_a = {pair(r) for r in rows[:first_b]}
assert first_b == 2 * len(block_a) == 16416, first_b  # 8208 pairs, both members inside
a_injections = {r["attack_identified_ts"] for r in rows[:first_b] if r["arm"] == "attack"}
origin = lambda r: pair(r) in block_a or r["attack_identified_ts"] in a_injections

attacks = [r for r in rows if r["arm"] == "attack"]
exfil = [r for r in attacks if r["goal_class"] == "exfiltration" or r["risk_category"] == "data-exfiltration"]
pool = [r for r in exfil if not origin(r) and f"{pair(r)}_benign" in by_id]
# One page per source injection: pages sharing a detection timestamp are variants of one injection, not independent cases.
pool.sort(key=lambda r: r["entry_id"])
rng = random.Random(SEED)
clusters = defaultdict(list)
for r in pool: clusters[r["attack_identified_ts"]].append(r)
distinct = [rng.choice(g) for _, g in sorted(clusters.items())]
lang = lambda r: (r["language_page"] or ["?"])[0]
strata = defaultdict(list)
for r in distinct: strata[(r["attack_type"], lang(r))].append(r)
# Proportional allocation, largest remainders (ties by stratum name), then a seeded draw inside each stratum.
quota = {k: N * len(g) / len(distinct) for k, g in strata.items()}
take = {k: int(q) for k, q in quota.items()}
for k in sorted(quota, key=lambda k: (-(quota[k] - take[k]), k))[: N - sum(take.values())]: take[k] += 1
chosen = []
for k in sorted(strata):
    g = sorted(strata[k], key=lambda r: r["entry_id"])
    rng.shuffle(g)
    chosen += g[: take[k]]
chosen.sort(key=lambda r: r["entry_id"])
assert len(chosen) == N, len(chosen)
wanted = [x for r in chosen for x in (r, by_id[f"{pair(r)}_benign"])]

content_file = os.path.join(out, "content.parquet")
have = {r["entry_id"]: r for r in pq.read_table(content_file).to_pylist()} if os.path.exists(content_file) else {}
missing = [r for r in wanted if r["entry_id"] not in have]
if missing:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script's folder out
    import hf_ranges as H
    groups = defaultdict(set)
    for r in missing: groups[r["file"]].add(r["row_group"])
    need = {r["entry_id"] for r in missing}
    for f_i in sorted(groups):
        with H.open_train(f_i) as f:
            pf = pq.ParquetFile(f, pre_buffer=True)
            for g in sorted(groups[f_i]):
                for row in pf.read_row_group(g, columns=["entry_id", "content_markdown", "content_html"]).to_pylist():
                    if row["entry_id"] in need: have[row["entry_id"]] = row
        print("file", f_i, len(groups[f_i]), "row groups", dict(H.fetched), file=sys.stderr, flush=True)
    pq.write_table(pa.Table.from_pylist(list(have.values())), content_file)
    open(os.path.join(out, "fetch-log.jsonl"), "a").write(json.dumps({"step": "content", "repo": H.REPO, "revision": H.REVISION, "pages": len(missing), **H.fetched}) + "\n")

LINK = re.compile(r"\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\((https?://[^\s)]+)(?:\s+\"[^\"]*\")?\)")
URL = re.compile(r"https?://[^\s\"'<>)\]]+")
def page(r):
    c = have[r["entry_id"]]
    md = c["content_markdown"]
    m = re.search(r"<title[^>]*>(.*?)</title>", c["content_html"], re.S | re.I)
    title = re.sub(r"\s+", " ", html.unescape(m.group(1))).strip() if m else ""
    links, seen = [], set()
    for text, url in LINK.findall(md):
        text = re.sub(r"\s+", " ", re.sub(r"[\\*_`#]", "", text)).strip()
        if url not in seen and text and len(url) <= 500:
            seen.add(url); links.append({"text": text[:160], "url": url})
    return title or r["title"], md, links

cases = []
for a in chosen:
    quotes = json.loads(a["attack_quotes_json"] or "[]")
    in_fragments = set(URL.findall(" ".join(json.loads(a["injection_text_fragments_json"] or "[]"))))
    for r in (a, by_id[f"{pair(a)}_benign"]):
        title, text, links = page(r)
        attack = r is a
        cases.append({
            "id": r["entry_id"], "arm": r["arm"], "pair": pair(r), "title": title, "dataset_title": r["title"], "benign_task": r["benign_task"],
            # The pair's strata on both members, so the control arm groups the same way.
            "attack_type": a["attack_type"], "language": lang(a), "injection_strategy": a["injection_strategy"], "linguistic_style": a["linguistic_style"],
            "goal_class": a["goal_class"], "risk_category": a["risk_category"], "requires_action_tools": a["requires_action_tools"],
            "page_type": r["page_type"], "domain": r["domain"], "language_page": r["language_page"], "attack_identified_ts": a["attack_identified_ts"],
            "malicious_goal": a["malicious_goal"] if attack else None,
            "injection_fragments": quotes if attack else [],
            "attacker_urls": sorted(u["url"] for u in links if u["url"] in in_fragments) if attack else [],
            "text": text, "links": links,
        })
blob = json.dumps(cases, ensure_ascii=False, indent=1, sort_keys=True).encode()
open(os.path.join(out, "cases.json"), "wb").write(blob)
digest = hashlib.sha256(blob).hexdigest()
open(os.path.join(out, "cases.sha256"), "w").write(f"{digest}  cases.json\n")
ids = hashlib.sha256("\n".join(c["id"] for c in cases).encode()).hexdigest()
squash = lambda s: re.sub(r"\s+", " ", s.replace("\\", "")).strip().lower()
shown = sum(any(squash(q)[:40] in squash(c["text"]) for q in c["injection_fragments"] if len(squash(q)) >= 12) for c in cases if c["arm"] == "attack")
summary = {
    "seed": SEED, "train_rows": len(rows), "train_attacks": len(attacks), "exfiltration_attacks": len(exfil),
    "block_a_pairs": len(block_a), "block_b_attacks_sharing_an_injection_with_block_a": sum(pair(r) not in block_a and origin(r) for r in attacks),
    "exfiltration_attacks_excluded_as_browsesafe_origin": sum(origin(r) for r in exfil),
    "pool_after_exclusion": len(pool), "distinct_source_injections": len(distinct), "strata": len(strata),
    "attack_cases": N, "control_cases": N, "cases_sha256": digest, "ids_sha256": ids,
    "attacks_whose_injection_is_in_the_markdown_text": shown,
    "by_attack_type": dict(Counter(r["attack_type"] for r in chosen).most_common()), "by_language": dict(Counter(lang(r) for r in chosen).most_common()),
    "by_injection_strategy": dict(Counter(r["injection_strategy"] for r in chosen).most_common()), "requires_action_tools": sum(r["requires_action_tools"] for r in chosen),
    "text_chars_median": sorted(len(c["text"]) for c in cases)[len(cases) // 2], "links_median": sorted(len(c["links"]) for c in cases)[len(cases) // 2],
}
json.dump(summary, open(os.path.join(out, "cases.summary.json"), "w"), indent=1)
print(json.dumps(summary, indent=1))

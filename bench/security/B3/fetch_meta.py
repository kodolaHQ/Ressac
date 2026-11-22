"""Step 1: the metadata columns of the BrowseSafe++ TRAIN split only (no screenshot, no page text).
  uv run --with pyarrow --with huggingface_hub python -I fetch_meta.py <out dir>
Never opens anything under test/ or screenshots/. Exact byte ranges only (no read-ahead); counts what it fetches.
One parquet per source file (a rerun skips those already there), then train-meta.parquet."""
import json, sys, os, threading
from concurrent.futures import ThreadPoolExecutor
import pyarrow as pa, pyarrow.parquet as pq
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script's folder out
import hf_ranges as H  # the pinned train files, the train-only guard and the byte counter

META = ["entry_id", "label", "arm", "title", "split", "benign_task", "attack_identified_ts", "attack_type", "expected_outcome",
        "goal_class", "injection_strategy", "malicious_goal", "register", "risk_category", "language_page", "requires_action_tools",
        "linguistic_style", "language_payload", "page_type", "domain", "injection_text_fragments_json", "attack_quotes_json"]
lock = threading.Lock()

out = sys.argv[1]

def one(i):
    dest = os.path.join(out, f"meta-{i:04d}.parquet")
    if os.path.exists(dest): return
    with H.open_train(i) as f:
        pf = pq.ParquetFile(f, pre_buffer=True)
        t = pf.read(columns=META)
        t = t.append_column("file", pa.array([i] * t.num_rows, pa.int32()))
        # each row's row group, to fetch the page text later by row group only
        rg = [g for g in range(pf.metadata.num_row_groups) for _ in range(pf.metadata.row_group(g).num_rows)]
        t = t.append_column("row_group", pa.array(rg, pa.int32()))
    pq.write_table(t, dest + ".tmp"); os.replace(dest + ".tmp", dest)
    with lock:
        print(i, t.num_rows, dict(H.fetched), file=sys.stderr, flush=True)

with ThreadPoolExecutor(7) as ex: list(ex.map(one, range(21)))
all_ = pa.concat_tables([pq.read_table(os.path.join(out, f"meta-{i:04d}.parquet")) for i in range(21)])
pq.write_table(all_, os.path.join(out, "train-meta.parquet"))
log = os.path.join(out, "fetch-log.jsonl")
open(log, "a").write(json.dumps({"step": "meta", "repo": H.REPO, "revision": H.REVISION, "rows": all_.num_rows, **H.fetched}) + "\n")
print("rows", all_.num_rows, H.fetched)

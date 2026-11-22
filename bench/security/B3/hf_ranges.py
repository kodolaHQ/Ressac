"""Shared by the fetch steps: the pinned train files of BrowseSafe++, read by exact byte ranges, with a byte counter.
Refuses any path outside data/members-train-*.parquet (never test/, never screenshots/)."""
import threading
from huggingface_hub import HfFileSystem
from huggingface_hub.hf_file_system import HfFileSystemFile

REPO = "perplexity-ai/browsesafe-plus-plus"
REVISION = "7674843074bf3b36c0a0209dfd06e03cf47743dd"
lock = threading.Lock()
fetched = {"bytes": 0, "requests": 0}
_orig = HfFileSystemFile._fetch_range
def _count(self, start, end):
    assert "/data/members-train-" in self.path, self.path
    b = _orig(self, start, end)
    with lock:
        fetched["bytes"] += len(b); fetched["requests"] += 1
    return b
HfFileSystemFile._fetch_range = _count
fs = HfFileSystem()
def open_train(i):
    return fs.open(f"datasets/{REPO}@{REVISION}/data/members-train-{i:04d}.parquet", "rb", cache_type="none")

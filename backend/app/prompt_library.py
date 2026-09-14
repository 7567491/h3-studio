"""Prompt 库管理:扫 /tmp/beatapi_repo/prompts/*.json 提供搜索。

跟 h3-viewer.py 里 _BEATAPI 一样的逻辑,但做成 FastAPI 友好版。
"""
import json
import logging
import time
from glob import glob
from pathlib import Path
from typing import Optional

from .config import PROMPT_LIBRARY_DIR

log = logging.getLogger("h3.prompt_library")

_CACHE: dict = {}
_CACHE_MTIME: float = 0.0
_CACHE_TTL = 60  # 秒,跟磁盘解耦


def _load_all() -> dict:
    """加载全部 prompt 到内存,带 TTL。"""
    global _CACHE, _CACHE_MTIME
    now = time.time()
    if _CACHE and (now - _CACHE_MTIME) < _CACHE_TTL:
        return _CACHE

    if not PROMPT_LIBRARY_DIR.exists():
        log.warning(f"prompt 库目录不存在: {PROMPT_LIBRARY_DIR}")
        _CACHE = {}
        _CACHE_MTIME = now
        return _CACHE

    items = {}
    for fp in glob(f"{PROMPT_LIBRARY_DIR}/*.json"):
        name = Path(fp).name
        if name in ("catalog.json", "README.md"):
            continue
        try:
            with open(fp) as f:
                d = json.load(f)
        except Exception as e:
            log.warning(f"跳过损坏的 prompt 文件 {fp}: {e}")
            continue

        slug = d.get("slug")
        prompt = d.get("prompt", "").strip()
        if not slug or not prompt:
            continue

        title = d.get("title") or {}
        items[slug] = {
            "slug": slug,
            "title": title.get("en") or title.get("zh") or slug,
            "title_zh": title.get("zh", ""),
            "category": d.get("category", "—"),
            "mode": d.get("mode", "text-to-video"),
            "duration": d.get("duration", "10s"),
            "aspect": d.get("aspectRatio", "16:9"),
            "prompt": prompt,
            "source": (d.get("source") or {}).get("name", "BeatAPI"),
        }

    _CACHE = items
    _CACHE_MTIME = now
    log.info(f"loaded {len(items)} prompts from {PROMPT_LIBRARY_DIR}")
    return _CACHE


def list_categories() -> list[tuple[str, int]]:
    """统计所有 category + 计数,按计数降序。"""
    items = _load_all()
    cats: dict[str, int] = {}
    for v in items.values():
        c = v["category"]
        cats[c] = cats.get(c, 0) + 1
    return sorted(cats.items(), key=lambda x: -x[1])


def search_prompts(q: str = "", category: str = "all", limit: int = 100) -> list[dict]:
    """搜 prompt。

    - q: 模糊匹配 title/prompt(desc 不参与,太慢)
    - category: all 或具体分类
    - limit: 默认 100,避免一次性返回 301 个,前端要分页
    """
    items = _load_all()
    q_lower = q.lower().strip()
    results = []
    for v in items.values():
        if category != "all" and v["category"] != category:
            continue
        if q_lower and q_lower not in v["title"].lower() and q_lower not in v["prompt"].lower():
            continue
        results.append({
            "slug": v["slug"],
            "title": v["title"],
            "category": v["category"],
            "duration": v["duration"],
        })
    return results[:limit]


def get_prompt(slug: str) -> Optional[dict]:
    """按 slug 拿完整 prompt。"""
    items = _load_all()
    v = items.get(slug)
    if not v:
        return None
    return {
        "slug": v["slug"],
        "title": v["title"],
        "prompt": v["prompt"],
        "category": v["category"],
        "duration": v["duration"],
        "mode": v["mode"],
        "aspect": v["aspect"],
    }


def total_count() -> int:
    return len(_load_all())

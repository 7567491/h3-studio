"""历史视频扫描 + ComfyUI /history 整合。

复用 h3-viewer.py 的逻辑,但不依赖 Flask,纯函数返回 JSON。
"""
import glob
import json
import logging
import time
from pathlib import Path
from typing import Optional

from .config import H3_UPLOADS_DIR

log = logging.getLogger("h3.history_scanner")


def _describe_mp4(mp4, date: str, st=None) -> dict | None:
    """把一个 mp4 文件 + 同名 .meta.json 转成 API item。

    st: 已拿到的 os.stat_result,避免在 s3fs 上重复 stat。

    返回 None 表示该视频已被"软删除"(meta.hidden=true),调用方应跳过。
    软删除 (2026-09-06 Jack 拍板): 视频文件保留在磁盘,只在前端不显示,
    不允许恢复 (前端没有"取消隐藏"按钮)。
    """
    meta_path = mp4.with_suffix(".mp4.meta.json")
    meta = {}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
        except Exception:
            pass

    # 软删除过滤: meta.hidden == True → 不返回,前端永远看不见
    if meta.get("hidden") is True:
        return None

    if st is None:
        st = mp4.stat()
    return {
        "slug": mp4.stem,
        "title": meta.get("title", mp4.stem),
        "filename": mp4.name,
        "size": st.st_size,
        "mtime": st.st_mtime,
        "upload_date": date,
        "web_path": f"/media/{date}/{mp4.name}",
        "meta": meta,
    }


def scan_local_uploads(limit: int = 50, date: Optional[str] = None) -> list[dict]:
    """扫 /mnt/mmm/video/art/uploads/<日期>/*.mp4。

    Args:
        limit: 最多返回多少个
        date: 指定日期子目录 → 只扫该目录;None = 聚合所有日期目录,按 mtime 倒序

    历史 bug (2026-08-28 修): 原实现默认只看"今天"的目录,今天目录还没建时
    fallback 用字符串排序取"最新"目录,结果 'v6-round3' (0 个 mp4) 排在
    '2026-08-27' (487 个 mp4) 前面 → 前端每天零点后必然显示"暂无视频"。
    现改为默认聚合全部目录,不再依赖当天目录存在。

    性能 (s3fs): 目录里 637 个 mp4 / 414 个 meta.json,全量读 meta 要 20-45s。
    所以先只 stat + 排序,截到 limit 之后才读那 limit 个的 meta.json → ~1-3s。
    """
    if not H3_UPLOADS_DIR.exists():
        log.warning(f"uploads 目录不存在: {H3_UPLOADS_DIR}")
        return []

    # 收集 (mtime, path, date) —— 只 stat,不碰 meta.json
    entries: list[tuple[float, object, str, object]] = []
    if date is not None:
        # 显式指定日期 → 只扫那一个目录(供日期筛选用)
        date_dir = H3_UPLOADS_DIR / date
        if not date_dir.exists():
            log.warning(f"指定日期目录不存在: {date_dir}")
            return []
        dirs = [date_dir]
    else:
        dirs = [d for d in H3_UPLOADS_DIR.iterdir() if d.is_dir()]

    for d in dirs:
        for mp4 in d.glob("*.mp4"):
            try:
                st = mp4.stat()
            except OSError as e:  # s3fs 偶发 stat 失败,跳过不要整体 500
                log.warning(f"跳过 {mp4}: {e}")
                continue
            entries.append((st.st_mtime, mp4, d.name, st))

    entries.sort(key=lambda e: -e[0])
    # 跨日期子目录去重 (2026-09-06 Jack RCA): orphan_recovery 9-04 那天把
    # 9-03 的 56 个孤儿复制到 9-04/9-05 目录, MD5 完全相同但 slug 重复.
    # 按 mtime 倒序后, 第一次见到的 slug 就是最新的 (其他是旧副本).
    seen_slugs: set[str] = set()
    out = []
    for _, mp4, dname, st in entries[:limit]:
        item = _describe_mp4(mp4, dname, st)
        if item is None:  # 软删除 (hidden=true) 跳过
            continue
        if item["slug"] in seen_slugs:
            log.debug(f"dup slug skipped: {item['slug']} in {dname}")
            continue
        seen_slugs.add(item["slug"])
        out.append(item)
    return out


def list_upload_dates() -> list[str]:
    """返回所有有视频的日期子目录名,新→旧。"""
    if not H3_UPLOADS_DIR.exists():
        return []
    return sorted(
        [d.name for d in H3_UPLOADS_DIR.iterdir() if d.is_dir()],
        reverse=True,
    )


async def get_comfy_history(max_items: int = 20) -> list[dict]:
    """从 ComfyUI /history 拿最近的任务(供 Queue Tab 显示)。"""
    from .comfyui_client import ComfyUIClient
    async with ComfyUIClient() as c:
        h = await c.get_history(max_items=max_items)
    out = []
    for prompt_id, items in list(h.items())[:max_items]:
        outputs = items.get("outputs", {})
        status = items.get("status", {})
        out.append({
            "prompt_id": prompt_id,
            "status": status.get("status_str", "unknown"),
            "completed": status.get("completed", False),
            "outputs": list(outputs.keys()),
        })
    return out

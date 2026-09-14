"""启动时扫描 ComfyUI 历史,补 staging 孤儿视频。

场景:
- 服务重启导致 _fetch_and_stage 后台 task 丢失
- 视频已经在 ComfyUI output 目录,但没拉到 h3-video 共享目录
- 启动时把这种孤儿补回来,避免历史"消失"
"""
import asyncio
import json
import logging
import time
from pathlib import Path

from .config import H3_UPLOADS_DIR
from .comfyui_client import ComfyUIClient

log = logging.getLogger("h3.orphan_recovery")


async def recover_orphans() -> int:
    """扫描 ComfyUI 历史,把 h3-video 共享目录里没有的 H3_studio_*.mp4 补过来。

    Returns:
        成功恢复的数量
    """
    recovered = 0
    try:
        # 注意 (2026-08-28 修): 这里以前有 date_dir.mkdir(parents=True)。
        # /mnt/mmm 是 s3fs 挂载 (user_id=0,group_id=0,目录 755),本服务跑在
        # hermes 身份下 → mkdir 必然 PermissionError,把整个恢复流程掐死在第一步,
        # 每次启动都刷 "recover_orphans failed: Permission denied"。
        # 实际不需要自己建目录: 下面第 70 行的 sudo 桥接 stage_h3_video.sh
        # 内部已经 `mkdir -p "$DEST_DIR"` 并 chmod 666。
        # 所以只用 date_dir 拼路径做 target.exists() 判重,不创建。
        date_dir = H3_UPLOADS_DIR / time.strftime("%Y-%m-%d")

        async with ComfyUIClient() as c:
            history = await c.get_history(max_items=100)

        for prompt_id, info in history.items():
            outputs = info.get("outputs", {})
            for node_id, out in outputs.items():
                for v in out.get("videos", []) + out.get("images", []):
                    fname = v.get("filename", "")
                    if not fname.startswith("H3_studio") or not fname.endswith(".mp4"):
                        continue
                    subfolder = v.get("subfolder", "")
                    target = date_dir / fname
                    if target.exists():
                        continue  # 已 staged

                    log.info(f"orphan found: {fname}, recovering from ComfyUI/{subfolder}")
                    try:
                        async with ComfyUIClient() as c:
                            async with c._session.get(
                                f"{c.base_url}/view",
                                params={"filename": fname, "subfolder": subfolder, "type": "output"},
                            ) as r:
                                if r.status != 200:
                                    log.warning(f"view {fname} → {r.status}")
                                    continue
                                tmp = Path("/tmp") / f"orphan_recover_{fname}"
                                with open(tmp, "wb") as f:
                                    async for chunk in r.content.iter_chunked(1 << 20):
                                        f.write(chunk)

                        # 拿 prompt (节点 10)
                        prompt_json = info.get("prompt", [None, None, {}])[2] if len(info.get("prompt", [])) >= 3 else {}
                        node10 = prompt_json.get("10", {}).get("inputs", {}) if isinstance(prompt_json, dict) else {}
                        prompt_text = node10.get("prompt", "(unknown)")

                        # sudo 桥接
                        import subprocess as sp
                        res = sp.run(
                            ["sudo", "-n", "/usr/local/bin/stage_h3_video.sh", str(tmp), fname],
                            capture_output=True, text=True, timeout=30,
                        )
                        if res.returncode != 0:
                            log.error(f"stage failed: {res.stderr[:200]}")
                            tmp.unlink(missing_ok=True)
                            continue
                        tmp.unlink(missing_ok=True)
                        log.info(f"recovered: {res.stdout.strip()}")

                        # 写 meta
                        meta = {
                            "src": str(target),
                            "imported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                            "media_type": "video",
                            "category": "art",
                            "subcat": f"uploads/{date_dir.name}",
                            "title": f"H3 Studio · {prompt_text[:60].strip()}",
                            "desc": f"[H3 Studio orphan-recovered] {prompt_text}",
                            "tags": ["h3", "studio", "web-ui", "orphan-recovered"],
                            "prompt": prompt_text,
                            "duration_s": 10,
                        }
                        meta_str = json.dumps(meta, ensure_ascii=False, indent=2)
                        meta_tmp = Path("/tmp") / f"orphan_recover_{fname}.meta.json"
                        meta_tmp.write_text(meta_str)
                        sp.run(["sudo", "-n", "cp", str(meta_tmp), str(target) + ".meta.json"], check=True, timeout=10)
                        sp.run(["sudo", "-n", "chmod", "666", str(target) + ".meta.json"], check=True, timeout=5)
                        meta_tmp.unlink(missing_ok=True)
                        recovered += 1
                    except Exception as e:
                        log.exception(f"recover {fname} failed: {e}")
    except Exception as e:
        log.exception(f"recover_orphans failed: {e}")

    log.info(f"orphan recovery complete: {recovered} recovered")
    return recovered
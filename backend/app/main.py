"""FastAPI 主入口 — 路由组装,各模块只 import 不修改。

路由:
  GET  /                              服务存活
  GET  /api/health                    健康检查
  GET  /api/comfyui/status            ComfyUI 健康 + /system_stats
  GET  /api/queue                     ComfyUI 队列
  GET  /api/prompts?q=&category=      搜 prompt 库
  GET  /api/prompts/categories        分类统计
  GET  /api/prompts/{slug}            单个 prompt 详情
  POST /api/submit                    提交生成任务(鉴权)
  GET  /api/submissions               列出最近提交
  GET  /api/submissions/{id}          单提交详情 + 进度快照
  GET  /api/history                   本机已生成视频列表
  GET  /api/history/dates             所有上传日期
  WS   /ws/progress/{submission_id}   订阅某 submission 的进度事件
"""
import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .config import CORS_ORIGINS, SERVICE_PORT, SERVICE_HOST
from .comfyui_client import ComfyUIClient, ComfyUIError
from .prompt_library import search_prompts, get_prompt, list_categories, total_count
from .expand_prompt import expand_prompt as do_expand_prompt
from .submit_manager import manager as submit_mgr, SubmitManager as _SubmitManagerT
from .history_scanner import scan_local_uploads, list_upload_dates, get_comfy_history
from .orphan_recovery import recover_orphans

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("h3.main")


app = FastAPI(title="H3 Studio API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup():
    """启动时恢复孤儿视频,避免服务重启导致 staging 丢失。"""
    log.info("startup: scanning for orphan H3_studio videos in ComfyUI output...")
    n = await recover_orphans()
    log.info(f"startup: orphan recovery done, {n} recovered")

    # 启动 GPU 显存历史采样守护线程 (load-on-start + 后台每 10s 采样)
    from .gpu_history import gpu_history
    gpu_history.start()

    # 启动 WebSocket 桥接器 (订阅 远端 ComfyUI WS, 转发 GPU 进度事件)
    from . import ws_bridge
    await ws_bridge.start()

    # 启动 GPU 进程采集后台任务 (每 5s SSH 一次拿真实 GPU 状态)
    from .gpu_processes import tracker as gpu_proc_tracker
    gpu_proc_tracker.start()


@app.on_event("shutdown")
async def on_shutdown():
    """停止后台采样线程 (FastAPI 退出时触发)。"""
    try:
        from .gpu_history import gpu_history
        gpu_history.stop()
    except Exception:
        pass
    try:
        from .ws_bridge import stop as ws_bridge_stop
        await ws_bridge_stop()
    except Exception:
        pass
    # 停 GPU 进程采集后台任务
    try:
        from .gpu_processes import tracker as gpu_proc_tracker
        gpu_proc_tracker.stop()
    except Exception:
        pass


# ========================================================== 数据模型

class SubmitRequest(BaseModel):
    # 2026-08-28: 从 2000 提到 4000 — H3 Ref2VA 6 段扩写典型 2500-3500 字符
    # (detailed_description 350-500 词, 加上 5 段小段)
    prompt_text: str = Field(..., min_length=1, max_length=4000)
    duration_s: int = Field(10, ge=1, le=30)
    seed: Optional[int] = Field(None, ge=0, le=2**32 - 1)
    # 分辨率预设: "480p" / "720p" / "1080p", 对应 RESOLUTION_PRESETS 里的 (w, h)
    # 默认 "480p" (832x480, 与原行为完全一致)
    resolution: str = Field("480p", pattern="^(480p|720p|1080p)$")
    # 可选参考图 (无 = 纯文生视频)
    # 格式: "h3studio/<filename>" 或其他 subfolder/name 形式
    # 业务上应该是 /api/upload-ref 上传后返回的 subfolder/name
    ref_image: Optional[str] = Field(None, max_length=512)


class PassRequest(BaseModel):
    """口令校验请求 — 前端发 sha256,后端比对"""
    pass_hash: str = Field(..., min_length=64, max_length=64)


# ========================================================== 健康

@app.get("/")
async def root():
    return {"service": "h3-studio-api", "version": "0.1.0", "ts": time.time()}


@app.get("/api/health")
async def health():
    """本服务存活,不依赖 ComfyUI。"""
    return {"ok": True, "ts": time.time()}


@app.post("/api/auth/check")
async def auth_check(req: PassRequest):
    """验证前端发来的口令 sha256 是否匹配。

    不返回任何敏感信息,只返回 ok 或 401。
    前端用 localStorage 存 hash,刷新页面后自动 reuse,不用再输。
    """
    from .config import H3_ACCESS_PASS_HASH
    if req.pass_hash != H3_ACCESS_PASS_HASH:
        raise HTTPException(401, "口令错误")
    return {"ok": True}


@app.get("/api/comfyui/status")
async def comfyui_status():
    """ComfyUI 健康 + GPU 显存状态。

    注意:
    - system.ram_* 是宿主机 RAM(无关 GPU)
    - 真正的 GPU 显存是 devices[].vram_*
    """
    try:
        async with ComfyUIClient() as c:
            stats = await c.get_system_stats()
        sys_info = stats.get("system", {})
        devices = stats.get("devices", [])

        # 拿第一个 GPU(6000 Pro 96GB),如果是多卡可扩展
        gpu = devices[0] if devices else {}
        vram_total = gpu.get("vram_total") or 0
        vram_free = gpu.get("vram_free") or 0
        vram_used = max(0, vram_total - vram_free)

        # 顺手采样到历史 buffer(给前端画 1h 折线图)
        from .gpu_history import gpu_history
        gpu_history.sample(vram_used, vram_total)

        return {
            "ok": True,
            "comfyui_version": sys_info.get("comfyui_version"),
            "torch_version": sys_info.get("pytorch_version"),
            # GPU(全部用 _gb 后缀,单位 GB 浮点,前端不要再换算)
            "gpu_name": gpu.get("name"),
            "gpu_type": gpu.get("type"),
            "vram_total_gb": round(vram_total / 1024**3, 2),
            "vram_used_gb": round(vram_used / 1024**3, 2),
            "vram_free_gb": round(vram_free / 1024**3, 2),
            "vram_used_pct": round(vram_used / vram_total * 100, 1) if vram_total else 0,
            "vram_free_pct": round(vram_free / vram_total * 100, 1) if vram_total else 0,
            # 整机 RAM(辅助信息,不是 GPU)
            "host_ram_total_gb": round(sys_info.get("ram_total", 0) / 1024**3, 1),
            "host_ram_free_gb": round(sys_info.get("ram_free", 0) / 1024**3, 1),
            "raw": stats,
        }
    except ComfyUIError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=503)


@app.websocket("/ws/gpu-events")
async def ws_gpu_events(websocket: WebSocket):
    """GPU 实时事件 WebSocket 端点 (前端 QueueTab 订阅).

    事件流:
      {"type": "queue_status", "queue_remaining": N}
      {"type": "executing", "node": "10", "prompt_id": "..."}
      {"type": "progress", "step": 5, "max_steps": 8, "prompt_id": "..."}
      {"type": "execution_start"|"execution_success"|"execution_error", "prompt_id": "..."}

    首次连接时发送 last_state 快照, 之后推送新事件。
    """
    await websocket.accept()
    from . import ws_bridge as _bridge

    # 1) 推一份 last_state 快照
    snap = _bridge.get_last_state()
    await websocket.send_json({"type": "snapshot", **snap})

    # 2) 订阅新事件
    q = await _bridge.subscribe()
    try:
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=30.0)
                await websocket.send_json(event)
            except asyncio.TimeoutError:
                # 心跳, 防止中间 CDN/代理切断
                await websocket.send_json({"type": "heartbeat"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning("ws_gpu_events: client error %s", e)
    finally:
        _bridge.unsubscribe(q)


@app.get("/api/gpu/history")
async def gpu_history_endpoint(seconds: int = Query(3600, ge=60, le=3600)):
    """返回过去 N 秒(默认 1 小时)的显存采样,用于前端画柱状图。

    返回格式:
    {
      "interval_s": 5,           # 采样间隔
      "total_slots": 720,        # 1h = 720 个 5s 槽
      "samples": [               # 长度 ≤ total_slots,从老到新
        {"t": 1234567890, "used_gb": 45.2, "total_gb": 95.0},
        ...
      ]
    }
    """
    from .gpu_history import gpu_history
    return gpu_history.snapshot(seconds=seconds)


# ========================================================== 队列

@app.get("/api/queue")
async def get_queue():
    """ComfyUI 队列快照 + ETA 估算。

    ETA 公式 (Jack 2026-09-06):
      - 每 5s 视频生成时间 = 60s, 每 1s 视频生成时间 = 20s
        ⇒ task_total_sec = duration_s * 60 + duration_s * 20 = duration_s * 80
      - 实时校准: 从 /history?max_items=10 拿最近成功任务的 length→sec,
        算 length×ratio 取代上面的 duration_s×80 粗估 (更准)
      - 全员 ETA = Σ(pending.est_total) + max(0, running[0].est_total - elapsed)
      - 我的 ETA = 我自己提交的最早一个未完成任务的 ETA
                  (在 pending 列表里=队首位置;在 running 列表里=上面的 running[0] 那一格)

    5 秒刷新 — Frontend useEffect setInterval(refresh, 5000)。
    """
    from .config import H3_DEFAULTS as D
    from .submit_manager import manager as SUBMIT_MANAGER

    # === 1) 实时校准: 最近 10 条 history → length → 实际耗时 ===
    #    length 不同 ratio 不同 (8 步 Turbo 是 length→linear,~24fps)
    sec_per_frame = D.get("sec_per_frame_default", 0.5)  # 兜底: 480p 832x480 8步~0.5s/frame
    samples: list[tuple[int, float]] = []  # [(length, total_sec), ...]
    try:
        async with ComfyUIClient() as c:
            hist = await c.get_history(max_items=10)
        # history: {prompt_id: {prompt:[...], status:{messages:[[ev, info]]}, ...}}
        for _pid, entry in (hist or {}).items():
            try:
                msgs = (entry.get("status") or {}).get("messages") or []
                start_ts = end_ts = None
                for ev_type, info in msgs:
                    ts = (info or {}).get("timestamp")
                    if ts is None:
                        continue
                    if ev_type == "execution_start" and start_ts is None:
                        start_ts = ts
                    elif ev_type == "execution_success":
                        end_ts = ts
                if not (start_ts and end_ts and end_ts > start_ts):
                    continue
                total_sec = (end_ts - start_ts) / 1000.0
                # length 从 prompt 节点 10 取
                prompt_dict = (entry.get("prompt") or [[], [], {}])[2] if isinstance(entry.get("prompt"), list) else {}
                node10 = (prompt_dict or {}).get("10", {})
                length = (node10.get("inputs") or {}).get("length") if isinstance(node10, dict) else None
                if isinstance(length, int) and length > 0:
                    samples.append((length, total_sec))
            except Exception:
                continue
        if samples:
            # 用最近 10 条的 length 加权算 sec_per_frame (按 length 长度加权,长视频误差更大)
            total_frames = sum(L for L, _ in samples)
            total_sec = sum(s for _, s in samples)
            if total_frames > 0 and total_sec > 0:
                sec_per_frame = total_sec / total_frames
    except Exception as e:
        log.warning(f"history 校准失败, fallback {sec_per_frame:.3f}s/frame: {e}")

    # === 2) 拿队列 + 算每个任务的 est_total_sec ===
    try:
        async with ComfyUIClient() as c:
            q = await c.get_queue()
        running = q.get("queue_running", []) or []
        pending = q.get("queue_pending", []) or []
    except ComfyUIError as e:
        raise HTTPException(503, f"ComfyUI 不可用: {e}")

    now = time.time()
    sub_lookup = SUBMIT_MANAGER.snapshot_for_queue()  # {prompt_id: sub_dict}

    def enrich(task_item, *, is_running: bool):
        s = _task_summary(task_item, sec_per_frame=sec_per_frame, now=now)
        # 如果后端 submit_manager 认识这个 prompt_id,补 running_started_at
        pid = s.get("prompt_id")
        if pid and pid in sub_lookup:
            sub = sub_lookup[pid]
            sub_dict = sub if isinstance(sub, dict) else sub.snapshot()
            rs = sub_dict.get("running_started_at")
            if rs and is_running:
                s["running_started_at"] = rs
                s["elapsed_sec"] = round(max(0.0, now - rs), 1)
            elif rs and not is_running:
                s["running_started_at"] = rs
            s["is_self"] = bool(sub_dict.get("submitter"))
            s["submission_id"] = sub_dict.get("submission_id", "")
        else:
            s["is_self"] = False
            s["submission_id"] = ""
            if is_running:
                s["elapsed_sec"] = 0  # 别人的任务不知道开始时间
        return s

    running_enriched = [enrich(t, is_running=True) for t in running[:10]]
    pending_enriched = [enrich(t, is_running=False) for t in pending[:10]]

    # === 3) 全员 ETA: Σ(pending.est_total) + max(0, running[0].est_total - elapsed) ===
    pending_total = sum(t["estimated_total_sec"] for t in pending_enriched)
    running0_remaining = 0
    if running_enriched:
        r0 = running_enriched[0]
        elapsed = r0.get("elapsed_sec", 0)
        running0_remaining = max(0, r0["estimated_total_sec"] - elapsed)
    total_eta_sec = pending_total + running0_remaining

    # === 4) 我的 ETA: 找自己提交的最早未完成任务 ===
    #    遍历 running+pending, 找 is_self=True 的第一个
    #    如果在 running[0]: 用 running0_remaining
    #    否则: 它前面所有 pending + 它自己的 est_total
    my_eta_sec: Optional[int] = None
    my_position_label: Optional[str] = None
    combined = list(running_enriched) + list(pending_enriched)
    for idx, t in enumerate(combined):
        if t.get("is_self"):
            # 它自己不在我前面(它已经在 running 或者它是第一个 pending)
            ahead = combined[:idx]  # 它前面所有的任务(包含 running[0] 减 elapsed)
            ahead_sum = 0
            for a in ahead:
                if a.get("running_started_at"):
                    ahead_sum += max(0, a["estimated_total_sec"] - a.get("elapsed_sec", 0))
                else:
                    ahead_sum += a["estimated_total_sec"]
            # 它自己: 在 running 时减 elapsed, 否则全部
            if t.get("running_started_at"):
                self_remain = max(0, t["estimated_total_sec"] - t.get("elapsed_sec", 0))
            else:
                self_remain = t["estimated_total_sec"]
            my_eta_sec = int(ahead_sum + self_remain)
            pos = idx + 1
            my_position_label = f"队列第 {pos} 位"
            break

    return {
        "running_count": len(running),
        "pending_count": len(pending),
        "running": running_enriched,
        "pending": pending_enriched,
        # === 新增: ETA 字段 ===
        # 历史校准的实时 sec_per_frame (前端调试 + 显示用)
        "sec_per_frame": round(sec_per_frame, 4),
        "calibration_samples": len(samples),
        # 1) 全员 ETA: Σpending + running[0] 剩余
        "eta_total_sec": int(total_eta_sec),
        # 2) 当前任务 ETA: 仅 running[0] 的剩余 (不含 pending 队列)
        #    没人在跑时 = 0
        "eta_running_sec": int(running0_remaining),
        # 3) 我自己提交的最早未完成任务 ETA
        "eta_self_sec": my_eta_sec,
        "eta_self_position": my_position_label,
        "ts": now,
    }


def _task_summary(task_item: list, *, sec_per_frame: float = 0.5, now: Optional[float] = None) -> dict:
    """ComfyUI 队列项格式: [number, prompt_id, prompt_dict, extra_data, executing_node]

    2026-09-06: 加 estimated_total_sec / length / duration_s / is_self
    公式 (Jack):
      - duration_s = length / 24 (按 24fps 推回原视频秒数)
      - task_total_sec = duration_s * 80  (5s→60s, 1s→20s)
      - 历史校准: length × sec_per_frame 覆盖上面的 80× 粗估
    """
    if not isinstance(task_item, list) or len(task_item) < 2:
        return {"raw": task_item}

    # 第 5 个元素 (index 4) 是 executing_node: ['80'] 表示节点 80 在跑
    executing_node = None
    if len(task_item) >= 5 and isinstance(task_item[4], list) and task_item[4]:
        executing_node = str(task_item[4][0])

    # prompt_id 提取
    prompt_id = str(task_item[1])

    # 已知节点 → 中文标签 (针对 H3 13 节点 workflow)
    node_label_map = {
        "10": "Prompt 编码",
        "20": "Latent 初始化",
        "30": "加载 LoRA",
        "31": "Sigma Shift",
        "40": "Turbo Sampler",
        "41": "Scheduler",
        "42": "随机噪声",
        "43": "CFG Guider",
        "50": "采样执行",
        "60": "VAE 解码(视频)",
        "61": "VAE 解码(音频)",
        "70": "合成视频",
        "80": "保存 MP4",
    }
    node_label = node_label_map.get(executing_node, executing_node or "未知")

    # === 2026-09-06: 估算总耗时 ===
    #    优先用历史校准的 sec_per_frame; 无 length 时退回 duration_s×80
    length = None
    prompt_dict = task_item[2] if len(task_item) > 2 and isinstance(task_item[2], dict) else {}
    node10 = prompt_dict.get("10", {}) if isinstance(prompt_dict, dict) else {}
    node10_inputs = node10.get("inputs", {}) if isinstance(node10, dict) else {}
    raw_length = node10_inputs.get("length") if isinstance(node10_inputs, dict) else None
    if isinstance(raw_length, int) and raw_length > 0:
        length = raw_length
    # duration_s 用 length/24fps 反推 (跟 H3_DEFAULTS["fps"]=24 对齐)
    duration_s = round(length / 24.0, 1) if length else 0.0
    # 总耗时 = length × sec_per_frame(校准后); 无 length 时按 duration_s×80 兜底
    if length:
        estimated_total_sec = int(round(length * sec_per_frame))
    elif duration_s:
        estimated_total_sec = int(duration_s * 80)  # 兜底: 5s→400s, 1s→80s
    else:
        estimated_total_sec = 0

    return {
        "queue_index": task_item[0],
        "prompt_id": prompt_id,
        "executing_node": executing_node,
        "node_label": node_label,
        "preview_prompt": _extract_prompt_preview(task_item[2] if len(task_item) > 2 else {}),
        # === ETA 相关字段 ===
        "length": length,                       # 帧数 (从节点 10 取)
        "duration_s": duration_s,              # 原始视频秒数 (length/24)
        "estimated_total_sec": estimated_total_sec,
        # running_started_at / elapsed_sec / is_self 由 caller 在 enrich() 里补
    }


def _extract_prompt_preview(prompt: dict) -> str:
    node10 = prompt.get("10", {})
    inputs = node10.get("inputs", {}) if isinstance(node10, dict) else {}
    text = inputs.get("prompt", "")
    if isinstance(text, str):
        return text[:80] + ("..." if len(text) > 80 else "")
    return ""


# ========================================================== Prompt 库

@app.get("/api/prompts")
async def api_prompts(
    q: str = Query("", description="搜索关键词"),
    category: str = Query("all"),
    limit: int = Query(50, ge=1, le=301),
):
    return {
        "q": q,
        "category": category,
        "total": total_count(),
        "results": search_prompts(q=q, category=category, limit=limit),
    }


@app.get("/api/prompts/categories")
async def api_prompt_categories():
    return {"categories": [{"name": n, "count": c} for n, c in list_categories()]}


@app.get("/api/prompts/{slug}")
async def api_prompt_detail(slug: str):
    p = get_prompt(slug)
    if not p:
        raise HTTPException(404, f"prompt slug 不存在: {slug}")
    return p


# ========================================================== Prompt 扩写

@app.post("/api/expand-prompt")
async def api_expand_prompt(
    request: Request,
    prompt: str = Form(...),
    duration_s: int = Form(5),
    ref_image: Optional[UploadFile] = File(None),
):
    """H3 提示词扩写端点。

    - 调用 miniMax H3 官方规范的 Ref2VA (有 ref) 或 T2VA (无 ref) 模板
    - 有 ref_image 时: 上传 multipart 文件 → 后端 → miniMax Text-01 vision 描述 → miniMax M3 扩写
    - 无 ref_image 时: 仅 miniMax M3 扩写
    - 预估耗时 8-15 秒 (1 次 vision + 1 次 text, 或仅 1 次 text)
    - 超时 240s
    """
    # 口令校验
    from .config import H3_ACCESS_PASS_HASH
    client_hash = request.headers.get("X-H3-Pass", "")
    if client_hash != H3_ACCESS_PASS_HASH:
        raise HTTPException(401, "口令错误 / invalid access password")

    # duration_s 校验
    if duration_s not in (5, 10, 15):
        raise HTTPException(400, f"duration_s 必须是 5/10/15, 收到 {duration_s}")

    # prompt 非空
    prompt = (prompt or "").strip()
    if not prompt:
        raise HTTPException(400, "prompt 不能为空")

    # ref_image (可选)
    ref_bytes: Optional[bytes] = None
    ref_mime = "image/jpeg"
    if ref_image is not None:
        ref_bytes = await ref_image.read()
        if not ref_bytes:
            ref_bytes = None  # 空文件当作没传
        else:
            ref_mime = ref_image.content_type or "image/jpeg"
            # mime 校验
            if not ref_mime.startswith("image/"):
                raise HTTPException(400, f"ref_image MIME 必须是 image/*, 收到 {ref_mime}")
            # 大小限制 10MB (前端已经压到 ≤10MB, 这里兜底)
            if len(ref_bytes) > 10 * 1024 * 1024:
                raise HTTPException(400, f"ref_image 超过 10MB ({len(ref_bytes)} bytes)")

    log.info("expand-prompt: duration=%ds, ref=%s, prompt_len=%d",
             duration_s, "yes" if ref_bytes else "no", len(prompt))

    try:
        result = do_expand_prompt(
            user_prompt=prompt,
            duration_s=duration_s,
            ref_image_bytes=ref_bytes,
            ref_image_mime=ref_mime,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        log.exception("expand-prompt failed")
        raise HTTPException(500, f"扩写失败: {type(e).__name__}: {e}")

    final_prompt = result["prompt"]
    prompt_len = len(final_prompt)
    # 2026-08-28: 后端 max_length=4000, 超过时给 warning 但不阻断 (前端决定是否截断)
    warning = None
    if prompt_len > 4000:
        warning = f"扩写 prompt 长度 {prompt_len} 字符, 超过 max_length=4000, 提交时会被后端拒绝"

    return {
        "prompt": final_prompt,
        "structured": result["structured"],
        "mode": result["mode"],
        "duration_s": result["duration_s"],
        "image_description": result["image_description"],
        "vision_error": result["vision_error"],
        "prompt_length": prompt_len,
        "warning": warning,
    }


# ========================================================== 提交

@app.post("/api/submit")
async def api_submit(req: SubmitRequest, request: Request):
    submitter = request.headers.get("X-User-Id", "anonymous")
    # 口令校验:客户端发 sha256(避免明文传),比对 hash
    from .config import H3_ACCESS_PASS_HASH
    client_hash = request.headers.get("X-H3-Pass", "")
    if client_hash != H3_ACCESS_PASS_HASH:
        raise HTTPException(401, "口令错误或缺失,请刷新页面重新输入")
    # resolution → (width, height)
    from .config import RESOLUTION_PRESETS
    width, height = RESOLUTION_PRESETS[req.resolution]
    try:
        sub = await submit_mgr.submit(
            prompt_text=req.prompt_text,
            duration_s=req.duration_s,
            seed=req.seed,
            width=width,
            height=height,
            ref_image=req.ref_image,
            submitter=submitter,
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ComfyUIError as e:
        raise HTTPException(502, f"ComfyUI 提交失败: {e}")
    return sub.snapshot()


@app.get("/api/submissions")
async def api_submissions(limit: int = Query(20, ge=1, le=100)):
    return {"submissions": submit_mgr.list_recent(limit=limit)}


@app.get("/api/submissions/{submission_id}")
async def api_submission_detail(submission_id: str):
    sub = submit_mgr.get(submission_id)
    if not sub:
        raise HTTPException(404, "submission 不存在(可能已重启服务)")
    return sub.snapshot()


# ========================================================== 历史

@app.get("/api/history")
async def api_history(limit: int = Query(50, ge=1, le=2000), date: Optional[str] = None):
    # 上限从 200 放宽到 2000 (2026-09-06 Jack RCA): 之前 limit>200 直接 422,
    # 前端如果误传大 limit 拿不到任何数据. 内部按 slug 去重, 大 limit 只是空跑.
    items = scan_local_uploads(limit=limit, date=date)
    return {"count": len(items), "items": items}


@app.get("/api/history/dates")
async def api_history_dates():
    return {"dates": list_upload_dates()}


# ========================================================== WebSocket 进度

@app.websocket("/ws/progress/{submission_id}")
async def ws_progress(websocket: WebSocket, submission_id: str):
    await websocket.accept()
    sub = submit_mgr.get(submission_id)
    if not sub:
        await websocket.send_json({"type": "error", "error": "submission 不存在"})
        await websocket.close()
        return

    # 先推一帧当前快照
    await websocket.send_json({"type": "snapshot", "data": sub.snapshot()})

    try:
        # 监听事件队列 + 心跳
        last_ping = time.time()
        while True:
            try:
                event = await asyncio.wait_for(sub.event_queue.get(), timeout=15.0)
                await websocket.send_json(event)
                if event.get("type") in ("done", "error"):
                    break
            except asyncio.TimeoutError:
                # 心跳
                await websocket.send_json({"type": "ping", "ts": time.time()})
                last_ping = time.time()
                # 如果 server 端状态已经 done/error,主动断开
                if sub.status in ("done", "error"):
                    break
    except WebSocketDisconnect:
        log.info(f"WS 断开: {submission_id}")
    except Exception as e:
        log.warning(f"WS error: {e}")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# ========================================================== 参考图上传

@app.post("/api/upload-ref")
async def api_upload_ref(request: Request):
    """前端上传参考图, 后端转发到 远端 ComfyUI /upload/image (subfolder=h3studio)。

    返回 { "ref_image": "h3studio/<saved_filename>", "size_bytes": N }。

    文件名 = "<uuid4 hex>.<原始后缀>", 避免多用户同名冲突 + 不污染 root input 目录。
    """
    from .config import COMFYUI_USERNAME, COMFYUI_PASSWORD, COMFYUI_BASE_URL
    from .comfyui_client import ComfyUIError
    import secrets

    # 1. 鉴权
    client_hash = request.headers.get("X-H3-Pass", "")
    from .config import H3_ACCESS_PASS_HASH
    if client_hash != H3_ACCESS_PASS_HASH:
        raise HTTPException(401, "口令错误或缺失")

    # 2. 读 multipart
    form = await request.form()
    if "image" not in form:
        raise HTTPException(400, "缺少 image 字段")
    upfile = form["image"]
    raw = await upfile.read()
    if not raw:
        raise HTTPException(400, "文件为空")

    # 3. 简单类型校验: 必须 PNG/JPG/WEBP (浏览器一般不会传其他格式, 防御性)
    suffix_map = {
        "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
        "image/webp": ".webp",
    }
    ctype = (upfile.content_type or "").lower()
    suffix = suffix_map.get(ctype)
    if not suffix:
        # 用文件头 magic bytes 推断
        if raw.startswith(b"\xff\xd8"): suffix = ".jpg"
        elif raw.startswith(b"\x89PNG"): suffix = ".png"
        elif raw.startswith(b"RIFF") and raw[8:12] == b"WEBP": suffix = ".webp"
        else:
            raise HTTPException(400, f"不支持的图片格式: {ctype}")

    # 4. 转发到 远端 ComfyUI /upload/image (subfolder=h3studio)
    filename = f"{secrets.token_hex(8)}{suffix}"
    subfolder = "h3studio"
    try:
        async with ComfyUIClient() as c:
            # /upload/image multipart 字段名是 image,type=input
            resp = await c.upload_image(
                filename=filename, data=raw, content_type=ctype,
                subfolder=subfolder, overwrite=False,
            )
    except ComfyUIError as e:
        log.error(f"upload_ref 上传到 ComfyUI 失败: {e}")
        raise HTTPException(502, f"上传到 ComfyUI 失败: {e}")

    log.info(f"upload_ref: saved as {subfolder}/{filename} ({len(raw)} bytes)")
    return {
        "ref_image": f"{subfolder}/{filename}",
        "size_bytes": len(raw),
    }


# ========================================================== 当前 GPU 上加载的模型 + 显存占用

# 来自 Comfy-Org 官方 repack 字节数 (smeltcore.com MiniMax-H3 字节级清单)
# safetensors int8 / fp16 / fp32 量化模型在 GPU 上加载时基本 1:1 占用 VRAM
# (int8 量化模型 19.5 GB 文件 ≈ 19.5 GB VRAM, fp16 同理)
# LoRA 是叠加的小适配器 (< 1 GB)
H3_MODEL_SIZES_BYTES = {
    # 主 DiT (pruned int8 convrot) — 推理时核心常驻
    "minimax_h3_fl2va_pruned_int8_convrot.safetensors": 20_970_379_616,
    # 文本编码器 (Qwen3-VL-32B NVFP4-AWQ) — 编码阶段常驻
    "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors": 15_687_142_551,
    # 视频 VAE (fp16) — 解码阶段常驻
    "minimax_h3_video_vae_fp16.safetensors": 5_207_808_496,
    # 音频 VAE (fp32) — 较小
    "minimax_h3_audio_vae_fp32.safetensors": 605_254_808,
    # LoRA 适配器 — < 1 GB
    "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors": 800_000_000,
    "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors": 800_000_000,
    "minimax_h3_turbo_v4_pruned_comfyui.safetensors": 800_000_000,
}

# 文件夹分类 (跟 ComfyUI /models/{folder} 对齐)
H3_MODEL_CATEGORIES = {
    "minimax_h3_fl2va_pruned_int8_convrot.safetensors": ("DiT", "diffusion_models", "🧠"),
    "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors":   ("Text Encoder", "text_encoders", "📝"),
    "minimax_h3_video_vae_fp16.safetensors":             ("Video VAE", "vae", "🎬"),
    "minimax_h3_audio_vae_fp32.safetensors":             ("Audio VAE", "vae", "🔊"),
    "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors": ("Turbo LoRA (8步)", "loras", "⚡"),
    "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors": ("Turbo LoRA (4步·768p)", "loras", "⚡"),
    "minimax_h3_turbo_v4_pruned_comfyui.safetensors":    ("Turbo LoRA (v4)", "loras", "⚡"),
}


@app.get("/api/models/loaded")
async def api_models_loaded():
    """返回当前 GPU 上加载的模型清单 + 各自 VRAM 占用 (基于文件大小).

    ComfyUI 自身不暴露 per-model 实时 VRAM, 但 safetensors 加载到 GPU
    基本 = 文件字节数 (int8 / fp16 / fp32 量化模型 1:1). 所以用 H3_MODEL_SIZES_BYTES 表查.

    额外一行: 激活/中间缓存 (runtime_overhead) = system_stats.vram_used - sum(file_sizes)
    这部分包括 ComfyUI 内部分配、attention KV cache、CPU↔GPU staging buffer 等.
    """
    from .config import H3_DEFAULTS

    # 1. 拉 ComfyUI /models/{folder} 看实际在用的文件 (动态确认)
    actual_files: dict[str, list[str]] = {}
    folders = ["diffusion_models", "text_encoders", "vae", "loras"]
    for folder in folders:
        try:
            async with ComfyUIClient() as c:
                resp = await c._get(f"/models/{folder}")
                # 响应是 string[]
                if isinstance(resp, list):
                    actual_files[folder] = [str(x) for x in resp]
                else:
                    actual_files[folder] = []
        except Exception:
            actual_files[folder] = []

    # 2. 拉 system_stats 算总占用
    vram_total_gb = 0.0
    vram_used_gb = 0.0
    try:
        async with ComfyUIClient() as c:
            stats = await c.get_system_stats()
        for d in stats.get("devices", []):
            vram_total = d.get("vram_total") or 0
            vram_free = d.get("vram_free") or 0
            vram_total_gb += vram_total / 1024**3
            vram_used_gb += max(0, vram_total - vram_free) / 1024**3
    except Exception:
        pass

    # 3. 找出当前在用的所有 H3 模型 (按文件夹分类)
    used_models: list[dict] = []
    total_static_gb = 0.0
    seen: set[str] = set()
    for folder, files in actual_files.items():
        for fname in files:
            if fname in seen:
                continue
            seen.add(fname)
            size_bytes = H3_MODEL_SIZES_BYTES.get(fname)
            cat_name, cat_folder, icon = H3_MODEL_CATEGORIES.get(
                fname, ("Unknown", folder, "📦"),
            )
            if size_bytes is None:
                # 不在硬编码表里 (比如用户换了个文件), 给个估算标记
                size_bytes_est = 5 * 1024**3  # 兜底 5GB
                used_models.append({
                    "filename": fname,
                    "category": cat_name,
                    "category_folder": cat_folder,
                    "icon": icon,
                    "size_bytes": None,
                    "size_bytes_est": size_bytes_est,
                    "size_gb_est": round(size_bytes_est / 1024**3, 2),
                    "is_estimate": True,
                    "is_h3_default": fname == H3_DEFAULTS.get("unet_name") or fname == H3_DEFAULTS.get("clip_name") or fname == H3_DEFAULTS.get("video_vae") or fname == H3_DEFAULTS.get("audio_vae") or fname == H3_DEFAULTS.get("turbo_lora"),
                })
                total_static_gb += size_bytes_est / 1024**3
            else:
                size_gb = size_bytes / 1024**3
                used_models.append({
                    "filename": fname,
                    "category": cat_name,
                    "category_folder": cat_folder,
                    "icon": icon,
                    "size_bytes": size_bytes,
                    "size_gb": round(size_gb, 2),
                    "is_estimate": False,
                    "is_h3_default": fname == H3_DEFAULTS.get("unet_name") or fname == H3_DEFAULTS.get("clip_name") or fname == H3_DEFAULTS.get("video_vae") or fname == H3_DEFAULTS.get("audio_vae") or fname == H3_DEFAULTS.get("turbo_lora"),
                })
                total_static_gb += size_gb

    # 4. 排序: 文件大的在前
    used_models.sort(key=lambda m: -(m.get("size_bytes") or m.get("size_bytes_est") or 0))

    # 5. 算 runtime overhead = vram_used - sum(static)
    #   这部分包括: ComfyUI framework 内部、attention KV cache、CPU↔GPU 中间 buffer、CUDA context
    runtime_overhead_gb = max(0.0, round(vram_used_gb - total_static_gb, 2))

    return {
        "vram_total_gb": round(vram_total_gb, 2),
        "vram_used_gb": round(vram_used_gb, 2),
        "static_models_total_gb": round(total_static_gb, 2),
        "runtime_overhead_gb": runtime_overhead_gb,
        "models": used_models,
        "fetched_at": time.time(),
    }


# ========================================================== GPU 真实进程状态 (nvidia-smi via SSH)
# 跟 /api/models/loaded 互补: 后者只看 ComfyUI torch context, 这个看整张卡所有进程 (含 vLLM 等)

@app.get("/api/gpu/processes")
async def api_gpu_processes():
    """返回 远端 ComfyUI GPU 上所有进程的真实状态 (整卡 stats + 每进程 VRAM + vLLM 模型)。

    5s 后台刷新, 失败 fallback 到上次快照。前端 5s 轮询此端点。
    """
    from .gpu_processes import tracker as gpu_proc_tracker
    return await gpu_proc_tracker.snapshot()


@app.post("/api/gpu/processes/refresh")
async def api_gpu_processes_refresh():
    """强制立刻刷新一次 (debug / 手动 trigger)。"""
    from .gpu_processes import tracker as gpu_proc_tracker
    return await gpu_proc_tracker.refresh_now()


# ========================================================== 隐藏视频 (软删除)

class DeleteRequest(BaseModel):
    """"删除"一个 H3 视频 — 实际上是软删除 (hidden flag)。

    软删除 (2026-09-06 Jack 拍板): 不删 .mp4 / .meta.json / .cover.jpg 文件,
    只在 .meta.json 写 hidden=true + hidden_at,扫描时过滤掉。
    - 全局生效 (所有前端用户都看不见)
    - 不允许恢复 (前端没有取消隐藏按钮)
    - 磁盘文件保留, 防止误删
    """
    filename: str = Field(..., min_length=1, max_length=200)
    upload_date: Optional[str] = Field(
        None, min_length=10, max_length=10,
        description="可选: 视频所在日期子目录 (YYYY-MM-DD), 加速查找",
    )
    # 防路径穿越: 只允许 H3_studio_XXXX_.mp4 命名格式
    # X = 数字 (5位+)

@app.post("/api/history/delete")
async def api_history_delete(req: DeleteRequest, request: Request):
    """软删除一个 H3 视频 — 在 .meta.json 写 hidden=true, 文件保留在磁盘。

    安全约束:
      - 必须有 X-H3-Pass (跟其他 endpoint 同一套鉴权)
      - filename 必须匹配 ^H3_studio_[0-9]{5,}_\\.mp4$ (防穿越, 防误删其他文件)
      - 优先按 upload_date 找; 不传则 fallback 扫描所有日期子目录
      - 必须在 H3_UPLOADS_DIR 下 (realpath 双保险)
    """
    from .config import H3_UPLOADS_DIR
    client_hash = request.headers.get("X-H3-Pass", "")
    from .config import H3_ACCESS_PASS_HASH
    if client_hash != H3_ACCESS_PASS_HASH:
        raise HTTPException(401, "口令错误或缺失")

    # 1. 严格白名单文件名 (防路径穿越)
    import re as _re
    import json as _json
    if not _re.fullmatch(r"H3_studio_[0-9]{5,}_\.mp4", req.filename):
        raise HTTPException(400, f"filename 不合法 (必须 H3_studio_NNNNN_.mp4): {req.filename}")

    # 2. 定位 .meta.json 路径
    #    优先按 upload_date 找 (前端会传), 不传则 fallback 扫描 (修跨日期 bug)
    meta_path: Path | None = None
    if req.upload_date and _re.fullmatch(r"\d{4}-\d{2}-\d{2}", req.upload_date):
        candidate = H3_UPLOADS_DIR / req.upload_date / (req.filename + ".meta.json")
        if candidate.exists():
            meta_path = candidate

    if meta_path is None:
        # fallback: 扫描所有日期子目录找 .meta.json
        # (修 2026-09-06 RCA: 删除只看今天目录, 昨天的都 404)
        for date_dir in H3_UPLOADS_DIR.iterdir():
            if not date_dir.is_dir() or not _re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_dir.name):
                continue
            candidate = date_dir / (req.filename + ".meta.json")
            if candidate.exists():
                meta_path = candidate
                break

    if meta_path is None:
        raise HTTPException(404, f"视频不存在: {req.filename}")

    # 3. 双保险: realpath 解析后确认还在 H3_UPLOADS_DIR 下
    uploads_real = H3_UPLOADS_DIR.resolve()
    meta_real = meta_path.resolve()
    if not str(meta_real).startswith(str(uploads_real)):
        raise HTTPException(400, "路径超出允许范围")

    # 4. 软删除: 读 .meta.json → 写 hidden=true + hidden_at → 写回
    #    保留其他字段不动 (title/prompt/duration/... 都在, 后续可恢复用, 但前端不暴露)
    try:
        meta = _json.loads(meta_real.read_text())
    except Exception:
        meta = {}  # .meta.json 损坏也不阻断, 重建一个最简版

    meta["hidden"] = True
    meta["hidden_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")

    # s3fs 挂载点只允许覆盖现有文件, 不能 create 新文件 (Permission denied on touch).
    # 所以放弃 .tmp + rename 原子写, 直接覆写 .meta.json.
    # 风险: 写一半崩溃 → .meta.json 半截 JSON → 下次扫描 try/except 兜底读 meta={} 重建.
    # 实测 .meta.json 是 0666 权限, hermes 进程覆写没问题.
    meta_real.write_text(_json.dumps(meta, ensure_ascii=False, indent=2))

    log.info(f"hidden: {req.filename} (upload_date={req.upload_date}, meta={meta_real})")
    return {
        "ok": True,
        "filename": req.filename,
        "hidden": True,
        "hidden_at": meta["hidden_at"],
        "note": "软删除: 文件保留在磁盘, 前端不再显示",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=SERVICE_HOST, port=SERVICE_PORT, reload=False, log_level="info")

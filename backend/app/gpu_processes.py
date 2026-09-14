"""GPU 进程级真实状态采集。

通过 SSH 出站到 远端 ComfyUI (<RTX_HOST> (从 RTX_SSH_HOST 读)), 用 nvidia-smi + vLLM OpenAI API
拿到 GPU 上**所有进程**的真实占用和加载的模型名, 而不是只看 ComfyUI torch context。

数据源 (3 路独立, 互相校验):
1. nvidia-smi --query-gpu       → 整卡 stats (total/used/free/util/temp/power)
2. nvidia-smi --query-compute-apps → 每个进程的 PID + name + VRAM
3. vLLM GET /v1/models           → vLLM 加载的模型 ID + root 路径 (走 SSH 上的 curl)

缓存: 5s 后台 asyncio 任务, 内存 dict。失败 fallback 到上次成功的快照。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from .config import (
    RTX_SSH_HOST, RTX_SSH_USER, RTX_SSH_PASS, RTX_SSH_KEY,
    RTX_VLLM_API_HOST, RTX_SSH_TIMEOUT_S,
)

log = logging.getLogger("h3.gpu_processes")

# 5s 刷新间隔 (前端要求)
REFRESH_INTERVAL_S = 5
# nvidia-smi CSV 期望列 (顺序固定, 跟 --format=csv,noheader,nounits 配)
NVIDIA_SMI_GPU_COLS = ["name", "memory.total", "memory.used", "memory.free",
                       "utilization.gpu", "temperature.gpu", "power.draw"]
NVIDIA_SMI_APP_COLS = ["pid", "process_name", "used_memory"]


def _ssh_cmd(remote_cmd: str, timeout: int = RTX_SSH_TIMEOUT_S) -> str:
    """同步 SSH 调用 (用 sshpass + stdin 喂密码, 避免 @ 转义问题)。

    参考 rtx-server-ssh skill: 必须用 echo 'pwd' | sshpass -P 'assword' ssh ...
    因为 RTX_SSH_PASS 含 '@' 用 -p 会 shell 转义崩。
    """
    import subprocess
    # sshpass 必须从 stdin 读密码; 用 bash -c 把 echo 包起来,密码不进 shell history
    # 用专用 key (没有密码)优先, 没 key 才用密码
    if RTX_SSH_KEY:
        ssh_args = [
            "ssh",
            "-i", RTX_SSH_KEY,
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR",
            "-o", "ConnectTimeout=5",
            f"{RTX_SSH_USER}@{RTX_SSH_HOST}",
            remote_cmd,
        ]
        proc = subprocess.run(ssh_args, capture_output=True, text=True, timeout=timeout)
    else:
        ssh_args = [
            "sshpass", "-P", "assword", "ssh",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR",
            "-o", "ConnectTimeout=5",
            f"{RTX_SSH_USER}@{RTX_SSH_HOST}",
            remote_cmd,
        ]
        proc = subprocess.run(
            ssh_args, input=RTX_SSH_PASS + "\n", text=True, timeout=timeout,
        )
    if proc.returncode != 0:
        # 容错: vLLM 失败时 (如 RT 的 127.0.0.1:8000 没监听, exit 7) 只记 warning,
        # 让上层 _fetch_all_sync 决定怎么处理
        raise RuntimeError(
            f"ssh failed rc={proc.returncode}: stderr={proc.stderr[:200]!r} cmd={remote_cmd[:80]!r}"
        )
    return proc.stdout


def _parse_csv_line(line: str) -> list[str]:
    return [c.strip() for c in line.split(",")]


def _fetch_gpu_stats_sync() -> dict:
    """同步获取整卡 nvidia-smi 数据。"""
    csv_out = _ssh_cmd(
        "nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,"
        "utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits"
    )
    line = csv_out.strip().splitlines()[0]
    cols = _parse_csv_line(line)
    row = dict(zip(NVIDIA_SMI_GPU_COLS, cols))
    # 统一单位: MiB → GB
    return {
        "name": row["name"],
        "memory_total_gb": round(int(row["memory.total"]) / 1024, 2),
        "memory_used_gb": round(int(row["memory.used"]) / 1024, 2),
        "memory_free_gb": round(int(row["memory.free"]) / 1024, 2),
        "utilization_gpu_pct": int(row["utilization.gpu"]),
        "temperature_c": int(row["temperature.gpu"]),
        "power_watts": float(row["power.draw"]),
    }


def _fetch_gpu_apps_sync() -> list[dict]:
    """同步获取 GPU 进程列表。"""
    csv_out = _ssh_cmd(
        "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits"
    )
    apps = []
    for line in csv_out.strip().splitlines():
        if not line.strip():
            continue
        cols = _parse_csv_line(line)
        row = dict(zip(NVIDIA_SMI_APP_COLS, cols))
        apps.append({
            "pid": int(row["pid"]),
            "process_name": row["process_name"],
            "used_memory_gb": round(int(row["used_memory"]) / 1024, 2),
        })
    # 按占 VRAM 降序
    apps.sort(key=lambda a: -a["used_memory_gb"])
    return apps


def _fetch_vllm_models_sync() -> list[dict]:
    """从 远端 ComfyUI 上的 vLLM 拉加载的模型。走 SSH 上的 curl。"""
    out = _ssh_cmd(f"curl -sS --max-time 4 '{RTX_VLLM_API_HOST}/v1/models' 2>&1")
    import json
    try:
        data = json.loads(out)
        models = data.get("data", [])
        return [{
            "id": m.get("id"),
            "root": m.get("root"),
            "max_model_len": m.get("max_model_len"),
            "owned_by": m.get("owned_by"),
        } for m in models]
    except Exception as e:
        log.warning(f"vLLM /v1/models parse err: {e}, raw={out[:200]}")
        return []


def _fetch_comfyui_models_sync() -> dict:
    """从 远端 ComfyUI 上的 ComfyUI REST API 拿模型目录列表。"""
    # 跟现有 comfyui_client 一样, 走 远端 ComfyUI ComfyUI REST
    # 这里直接用 curl 走 SSH
    folders = ["checkpoints", "diffusion_models", "vae", "loras", "text_encoders"]
    out = {}
    for folder in folders:
        try:
            raw = _ssh_cmd(
                f"curl -sS --max-time 4 -H 'User-Agent: Mozilla/5.0 Chrome/120' "
                f"http://127.0.0.1:8188/models/{folder}"
            )
            # JSON 数组
            import json as _json
            out[folder] = _json.loads(raw)
        except Exception as e:
            log.warning(f"comfyui /models/{folder} err: {e}")
            out[folder] = []
    return out


# Loader 节点用 input key 取真实加载的模型文件名
# ref: rtx-server-ssh SKILL §"🪨 坑 #4: 模型文件名散落在多种 input key"
_LOADER_KEYS = ("unet_name", "clip_name", "vae_name", "lora_name", "model_name")


def _fetch_comfyui_loaded_sync() -> Optional[dict]:
    """从 ComfyUI /history 解析"GPU 上当前真实加载的模型集合"。

    ComfyUI 不暴露 "loaded models" REST API — 只能从最近一个任务的 Loader 节点
    (UNETLoader / CLIPLoader / VAELoader / MiniMaxH3TurboLoRA / CheckpointLoaderSimple)
    的 input 反推。如果跑的是 acestep / 其它非 H3 工作流, 这里就只看到那些模型,
    前端不应该再硬显示 H3 默认那 5 个。

    返回:
      {
        "filenames": [..],         # 真实加载的 safetensors 文件名 (去重)
        "sizes_bytes": {fn: N},     # 每个文件的磁盘大小 (bytes), 从 find -printf %s 拿
        "prompt_id": "..",          # 来源 prompt uuid
        "timestamp_ms": 1234567,    # 任务时间戳 (毫秒)
        "age_seconds": 12.3,        # 距今多久
      }
      或 None (history 为空 / 解析失败 / 无 Loader 节点)
    """
    try:
        raw = _ssh_cmd(
            "curl -sS --max-time 4 -H 'User-Agent: Mozilla/5.0 Chrome/120' "
            "'http://127.0.0.1:8188/history?max_items=5'"
        )
    except Exception as e:
        log.warning(f"comfyui /history fetch err: {e}")
        return None

    import re as _re

    # 找最新一个 prompt block: 第一个出现的 uuid + 它后面到下一个 uuid 之前
    pid_pat = _re.compile(
        r'"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\s*:\s*\{'
    )
    pids = list(pid_pat.finditer(raw))
    if not pids:
        log.info("[gpu_processes] /history 返回 0 条任务, 无 loaded 数据")
        return None

    first = pids[0]
    # block 范围: 从第一个 { 到下一个 uuid 开头之前
    block_start = first.end() - 1
    block_end = pids[1].start() if len(pids) > 1 else len(raw)
    block = raw[block_start:block_end]

    # 只取 success 任务
    st = _re.search(r'"status_str"\s*:\s*"([^"]+)"', block)
    if st and st.group(1) != "success":
        log.info(f"[gpu_processes] 最新任务 status={st.group(1)}, 不计入 loaded")
        return None

    # 收集 Loader 节点的 input 字段
    ckpt_pat = _re.compile(
        r'"(?:' + '|'.join(_LOADER_KEYS) + r')"\s*:\s*"([^"]+\.(?:safetensors|pt|bin|ckpt))"'
    )
    names = ckpt_pat.findall(block)

    # 任务时间戳
    ts = _re.search(r'"timestamp"\s*:\s*(\d{13,16})', block)
    ts_ms = int(ts.group(1)) if ts else None

    if not names:
        return None

    # 去重保序
    seen = set()
    filenames = []
    for n in names:
        if n not in seen:
            seen.add(n)
            filenames.append(n)

    age_s = None
    if ts_ms is not None:
        # timestamp 单位不固定: ms / s 都见过, 自动判断
        ts_norm = ts_ms if ts_ms > 1e12 else ts_ms * 1000
        age_s = round((time.time() * 1000 - ts_norm) / 1000.0, 1)

    # 拿真实文件大小 — 一次性 find ComfyUI/models 下所有 safetensors, 按文件名查表
    # 用 mtime 排序加 size, 输出 "<f> <size>\n"
    sizes: dict[str, int] = {}
    try:
        size_raw = _ssh_cmd(
            "find /home/claude/ComfyUI/models -type f "
            "\\( -name '*.safetensors' -o -name '*.pt' -o -name '*.bin' -o -name '*.ckpt' \\) "
            "-printf '%f %s\\n' 2>/dev/null"
        )
        for line in size_raw.strip().splitlines():
            parts = line.rsplit(" ", 1)
            if len(parts) == 2 and parts[1].isdigit():
                sizes[parts[0]] = int(parts[1])
    except Exception as e:
        log.warning(f"comfyui /models size fetch err: {e}")

    return {
        "filenames": filenames,
        "sizes_bytes": sizes,  # 全量, 不只 loaded; 前端按 fn 查
        "prompt_id": first.group(1),
        "timestamp_ms": ts_ms,
        "age_seconds": age_s,
    }


class GPUProcessTracker:
    """后台 5s 异步刷新 + 内存快照。"""

    def __init__(self):
        self._last_snapshot: Optional[dict] = None
        self._last_error: Optional[str] = None
        self._last_fetch_t: float = 0.0
        self._lock = asyncio.Lock()
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()

    def start(self):
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._run_loop())
        log.info("[gpu_processes] started, refresh every %ds", REFRESH_INTERVAL_S)

    def stop(self):
        self._stop.set()
        if self._task:
            self._task.cancel()

    async def _run_loop(self):
        # 启动立刻跑一次 (不等满5s)
        await self._refresh_once()
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=REFRESH_INTERVAL_S)
                return  # stop 被 set
            except asyncio.TimeoutError:
                pass
            await self._refresh_once()

    async def _refresh_once(self):
        # 同步 SSH 调用在线程里跑, 不阻塞 event loop
        try:
            snap = await asyncio.to_thread(self._fetch_all_sync)
            async with self._lock:
                self._last_snapshot = snap
                self._last_error = None
                self._last_fetch_t = time.time()
        except Exception as e:
            async with self._lock:
                self._last_error = str(e)[:200]
                # 保留上次快照 (fallback)
            log.warning(f"[gpu_processes] refresh failed: {e}")

    def _fetch_all_sync(self) -> dict:
        # 容错: 每个子系统失败互不影响, GPU 整卡 + 进程是最关键的, vLLM/ComfyUI 模型可缺
        def _safe(name: str, fn):
            try:
                return fn()
            except Exception as e:
                log.warning(f"[gpu_processes] {name} fetch failed: {e}")
                return None

        gpu = _safe("gpu_stats", _fetch_gpu_stats_sync)
        apps = _safe("gpu_apps", _fetch_gpu_apps_sync)
        vllm = _safe("vllm_models", _fetch_vllm_models_sync)
        comfyui_models = _safe("comfyui_models", _fetch_comfyui_models_sync) or {}
        comfyui_loaded = _safe("comfyui_loaded", _fetch_comfyui_loaded_sync)

        return {
            "gpu": gpu,
            "processes": apps or [],
            "vllm_models": vllm or [],
            "comfyui_models_on_disk": comfyui_models,
            "comfyui_currently_loaded": comfyui_loaded,  # None=无 history/无 Loader, list=真实加载
            "fetched_at": time.time(),
        }

    async def snapshot(self) -> dict:
        async with self._lock:
            if self._last_snapshot is None:
                return {
                    "gpu": None,
                    "processes": [],
                    "vllm_models": [],
                    "comfyui_models_on_disk": {},
                    "comfyui_currently_loaded": None,
                    "fetched_at": 0.0,
                    "stale": True,
                    "last_error": self._last_error or "no data yet",
                }
            out = dict(self._last_snapshot)
            out["stale"] = (time.time() - self._last_fetch_t) > REFRESH_INTERVAL_S * 3
            out["last_error"] = self._last_error
            return out

    async def refresh_now(self) -> dict:
        """强制刷新一次。"""
        await self._refresh_once()
        return await self.snapshot()


# 单例
tracker = GPUProcessTracker()
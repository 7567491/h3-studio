"""GPU 显存持久化采样器。

设计:
- 独立后台线程,启动时立即读一次 + 之后每 10s 采样一次
- 数据落到 /tmp/h3-gpu-history.jsonl (append-only, 每行一条 JSON)
- 最多保留 24 小时: 启动时读全部 → 过滤 → 重写 (truncate)
- 提供 snapshot() 给前端, 默认返回过去 1 小时, 可指定 seconds
- 进程重启可恢复历史 (从 jsonl 读), 但超过 24h 强制丢

为什么 10s 不是 5s: 24h * 8640/h * 10s = ~120MB/天, 文件大小可接受。
前端 /api/gpu/history?seconds=N 接口形状不变, sample 字段保持 {t, used_gb, total_gb}。
"""
import json
import os
import threading
import time
from collections import deque
from typing import Optional

# 24 小时上限 = 86400s
RETENTION_S = 86400
# 采样间隔 (10s, 平衡精度 vs 24h 文件大小)
INTERVAL_S = 10
# JSONL 文件路径 (放在 /tmp, 进程重启可恢复, 但 s3fs 不挂这)
HISTORY_FILE = "/tmp/h3-gpu-history.jsonl"


class GpuHistory:
    def __init__(self):
        self._buf: deque = deque()  # 不再用 maxlen 限长, 由 retention 负责
        self._lock = threading.Lock()
        self._last_sample_t = 0.0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ----------------------------- 后台线程 -----------------------------

    def start(self) -> None:
        """启动后台采样线程。FastAPI startup 时调用一次。"""
        if self._thread and self._thread.is_alive():
            return  # 已启动
        self._load_from_disk()  # 启动时恢复历史
        self._thread = threading.Thread(
            target=self._run, name="gpu-history-sampler", daemon=True
        )
        self._thread.start()
        print(f"[gpu_history] started, file={HISTORY_FILE}, "
              f"loaded {len(self._buf)} samples from disk")

    def stop(self) -> None:
        """FastAPI shutdown 时调用。"""
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        print("[gpu_history] stopped")

    def _run(self) -> None:
        """后台线程主循环: 每 INTERVAL_S 采样一次, 每分钟 enforce retention.

        重要: 后台线程在独立 event loop 里跑 ComfyUI 异步调用 (asyncio.run)
        —— 不能用主 FastAPI 的 event loop (会报错)。
        """
        last_retention_t = 0.0
        # 启动时立刻采一次 (用独立 loop)
        try:
            self._sample_once_in_loop()
        except Exception as e:
            print(f"[gpu_history] initial sample error: {e}")
        while not self._stop.is_set():
            try:
                # 每 60s enforce 一次 24h retention
                if time.time() - last_retention_t > 60:
                    self._enforce_retention()
                    last_retention_t = time.time()
            except Exception as e:
                print(f"[gpu_history] retention error: {e}")
            self._stop.wait(INTERVAL_S)
            # 醒来后采样
            try:
                self._sample_once_in_loop()
            except Exception as e:
                print(f"[gpu_history] sample error: {e}")

    def _sample_once_in_loop(self) -> None:
        """在独立 asyncio loop 里调 ComfyUI /system_stats。"""
        import asyncio
        from .comfyui_client import ComfyUIClient

        async def _fetch():
            async with ComfyUIClient() as c:
                return await c.get_system_stats()

        stats = asyncio.run(_fetch())
        devices = stats.get("devices") or []
        if not devices:
            return
        gpu = devices[0]
        vram_total = int(gpu.get("vram_total") or 0)
        vram_free = int(gpu.get("vram_free") or 0)
        vram_used = max(0, vram_total - vram_free)
        if vram_total <= 0:
            return
        self.sample(vram_used, vram_total)

    # ----------------------------- 数据持久化 -----------------------------

    def _load_from_disk(self) -> None:
        """启动时读 jsonl, 过滤 >24h, 加载到内存 buffer。"""
        if not os.path.exists(HISTORY_FILE):
            return
        cutoff = time.time() - RETENTION_S
        loaded: deque = deque()
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                        t = float(row.get("t", 0))
                        if t >= cutoff:
                            loaded.append({
                                "t": int(t),
                                "used_gb": float(row["used_gb"]),
                                "total_gb": float(row["total_gb"]),
                            })
                    except (json.JSONDecodeError, KeyError, TypeError):
                        continue  # 单行损坏不影响其它
        except OSError as e:
            print(f"[gpu_history] load error: {e}")
            return
        # 按时间排序加载
        loaded = deque(sorted(loaded, key=lambda s: s["t"]))
        with self._lock:
            self._buf = loaded
        # 如果加载后还超过 retention, 强制 truncate 文件
        if loaded:
            self._rewrite_file()

    def _append_to_file(self, row: dict) -> None:
        """追加一行 JSON 到文件。失败不致命 (临时不可写不要挂前端)。"""
        try:
            with open(HISTORY_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError as e:
            print(f"[gpu_history] append error: {e}")

    def _rewrite_file(self) -> None:
        """把当前 buffer 全部重写到文件(覆盖)。用于 enforce retention。"""
        try:
            tmp = HISTORY_FILE + ".tmp"
            with self._lock:
                rows = list(self._buf)
            with open(tmp, "w", encoding="utf-8") as f:
                for row in rows:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
            os.replace(tmp, HISTORY_FILE)  # atomic rename
        except OSError as e:
            print(f"[gpu_history] rewrite error: {e}")

    def _enforce_retention(self) -> None:
        """每分钟检查一次, 把 >24h 的从 buffer 和文件都清掉。"""
        cutoff = time.time() - RETENTION_S
        with self._lock:
            old_len = len(self._buf)
            self._buf = deque(s for s in self._buf if s["t"] >= cutoff)
            new_len = len(self._buf)
        if old_len != new_len:
            print(f"[gpu_history] retention: {old_len} -> {new_len} samples")
            self._rewrite_file()

    # ----------------------------- 公共 API -----------------------------

    def sample(self, used_bytes: int, total_bytes: int) -> None:
        """手动触发采样(供 /api/comfyui/status 同步调用 / 测试用)。

        守护线程已经在跑, 这里只在没启动守护线程时用 (e.g. 单测)。
        """
        now = time.time()
        with self._lock:
            # 节流: 5s 内重复采样只保留最新一条
            if self._buf and now - self._buf[-1]["t"] < 5:
                self._buf[-1] = {
                    "t": int(now),
                    "used_gb": round(used_bytes / 1024 ** 3, 2),
                    "total_gb": round(total_bytes / 1024 ** 3, 2),
                }
            else:
                row = {
                    "t": int(now),
                    "used_gb": round(used_bytes / 1024 ** 3, 2),
                    "total_gb": round(total_bytes / 1024 ** 3, 2),
                }
                self._buf.append(row)
                self._append_to_file(row)
            self._last_sample_t = now

    def snapshot(self, seconds: int = 3600) -> dict:
        """返回过去 N 秒的样本 (默认 1h)。

        返回结构兼容旧版前端: {interval_s, max_samples, current_count, samples}
        max_samples 改成 retention 段的总容量 (86400 / INTERVAL_S = 8640), 历史参考意义。
        """
        now = time.time()
        cutoff = now - seconds
        with self._lock:
            samples = [s for s in self._buf if s["t"] >= cutoff]
        return {
            "interval_s": INTERVAL_S,
            "max_samples": RETENTION_S // INTERVAL_S,  # 8640 = 24h @ 10s
            "retention_s": RETENTION_S,
            "current_count": len(samples),
            "samples": samples,
        }


# 全局单例
gpu_history = GpuHistory()

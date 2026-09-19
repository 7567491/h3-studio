"""提交任务管理 + 进度追踪。

设计:
- 每个提交生成一个 unique submission_id(UUID),跟 ComfyUI prompt_id 区分
- 所有 submission 状态保存在内存 dict(进程重启会丢,但视频文件还在磁盘)
- 进度通过 asyncio.Event / Queue 在 submit_manager 和 WS endpoint 间传递
- 鉴权:在 submit 时校验 ALLOWED_SUBMITTERS 白名单
"""
import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

from .config import ALLOWED_SUBMITTERS, H3_DEFAULTS, H3_UPLOADS_DIR
from .comfyui_client import ComfyUIClient, ComfyUIError
from .workflow_builder import build_h3_workflow

log = logging.getLogger("h3.submit_manager")


@dataclass
class Submission:
    """一个提交的完整生命周期记录。"""
    submission_id: str
    prompt_text: str
    duration_s: int
    seed: int
    client_id: str          # 用户的 WS 连接 ID,ComfyUI 也用它
    submitter: str          # 谁提交的
    submitted_at: float = field(default_factory=time.time)
    prompt_id: Optional[str] = None        # ComfyUI 返回的 prompt_id
    status: str = "pending"                 # pending/submitted/running/done/error
    progress: float = 0.0                   # 0..1
    progress_step: int = 0                  # 当前 step
    progress_max: int = H3_DEFAULTS["steps"]
    error: Optional[str] = None
    finished_at: Optional[float] = None
    # 2026-09-06: 进入 ComfyUI queue_running 的那一刻
    # (ComfyUI /queue_running 不返回 start ts,只能后端本地记;
    # 用 execution_start_ts(毫秒)对比历史均值算 elapsed)
    running_started_at: Optional[float] = None
    output_files: list = field(default_factory=list)
    # 参考图 (subfolder/name, 例如 "h3studio/abc123.jpg"); None = 纯文生
    # History Tab 用这个区分带 ref vs 纯文生的视频
    ref_image: Optional[str] = None
    # 进度事件订阅队列,WS endpoint 会 listen
    event_queue: asyncio.Queue = field(default_factory=asyncio.Queue)

    def snapshot(self) -> dict:
        """对外的 JSON 视图(不暴露 event_queue)。

        不要用 dataclasses.asdict(self) —— 它会走 deepcopy 整个对象,
        event_queue 是 asyncio.Queue(含 Future), deepcopy 会抛
        'cannot pickle _asyncio.Future object' (traceback 2026-08-28)。
        """
        return {
            "submission_id": self.submission_id,
            "prompt_id": self.prompt_id or "",
            "prompt_text": self.prompt_text,
            "status": self.status,
            "duration_s": self.duration_s,
            "seed": self.seed,
            "client_id": self.client_id,
            "submitter": self.submitter,
            "submitted_at": self.submitted_at,
            "finished_at": self.finished_at,
            "running_started_at": self.running_started_at,
            "progress": self.progress,
            "progress_step": self.progress_step,
            "progress_max": self.progress_max,
            "error": self.error,
            "ref_image": self.ref_image,
            "output_files": list(self.output_files),  # 浅拷贝, 已存的 items 都是 dict
        }


class SubmitManager:
    """所有提交任务的状态 + 进度总线。"""

    def __init__(self):
        self._subs: dict[str, Submission] = {}
        self._lock = asyncio.Lock()
        # 内部后台任务:把 ComfyUI WS 消息分发到各 submission 的 event_queue

    # ---------------------------------------------------------- 公共查询

    def snapshot_for_queue(self) -> dict[str, dict]:
        """给 /api/queue 用:返回 {prompt_id: sub_snapshot_dict},便于把 running_started_at
        注入到队列任务的 enrich 结果。

        只覆盖状态非 done/error 的 submission(prompt_id 必须已分配)。
        """
        out: dict[str, dict] = {}
        for sub in self._subs.values():
            if sub.prompt_id and sub.status in ("submitted", "running"):
                out[sub.prompt_id] = sub.snapshot()
        return out

    # ---------------------------------------------------------- 鉴权

    @staticmethod
    def check_auth(submitter: str) -> bool:
        """白名单校验。

        submitter 来自 X-User-Id header(前端从 cookie 或 URL 注入)。
        第一次先做最宽松校验:任何非空字符串都通过,只做 rate limit。
        """
        if not submitter:
            return False
        if not ALLOWED_SUBMITTERS:
            return True  # 没配白名单就是公开模式
        return submitter in ALLOWED_SUBMITTERS

    # ---------------------------------------------------------- 公开 API

    async def submit(
        self,
        *,
        prompt_text: str,
        submitter: str,
        duration_s: int = 10,
        seed: Optional[int] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
        ref_image: Optional[str] = None,
        client_id: Optional[str] = None,
    ) -> Submission:
        """用户提交 prompt。返回 Submission(含 submission_id)。

        流程:
        1. 鉴权
        2. 组装 H3 workflow
        3. 调 ComfyUI /prompt
        4. 启后台任务:订阅 ComfyUI WS,把进度事件推送到 sub.event_queue
        """
        if not self.check_auth(submitter):
            raise PermissionError(f"submitter '{submitter}' 不在白名单 {ALLOWED_SUBMITTERS}")

        submission_id = str(uuid.uuid4())
        client_id = client_id or f"h3-{submission_id[:8]}"
        seed = seed if seed is not None else H3_DEFAULTS["default_seed"]

        sub = Submission(
            submission_id=submission_id,
            prompt_text=prompt_text,
            duration_s=duration_s,
            seed=seed,
            client_id=client_id,
            submitter=submitter,
            ref_image=ref_image,
        )

        async with self._lock:
            self._subs[submission_id] = sub

        # 组 workflow + 提交 ComfyUI (这一步同步等返回)
        workflow = build_h3_workflow(
            prompt_text, duration_s=duration_s, seed=seed,
            width=width, height=height, ref_image=ref_image,
        )
        try:
            async with ComfyUIClient() as c:
                prompt_id = await c.submit(workflow, client_id=client_id)
        except ComfyUIError as e:
            sub.status = "error"
            sub.error = f"ComfyUI submit 失败: {e}"
            sub.finished_at = time.time()
            log.error(f"submit failed: {e}")
            raise

        sub.prompt_id = prompt_id
        sub.status = "submitted"

        # 启后台轮询 (<COMFYUI_HOST> 的 nginx 反代吃掉了 Upgrade header,
        # 让 ComfyUI 的 /ws 收到 None 并返回 400; 改用 /history REST 轮询)
        asyncio.create_task(self._track_by_polling(sub))

        log.info(f"submitted {submission_id} → prompt_id={prompt_id} client_id={client_id}")
        return sub

    async def _track_by_polling(self, sub: Submission) -> None:
        """通过 /queue + /history REST 轮询跟踪 ComfyUI 任务进度。

        替代原本的 ws_listen(): 远端 ComfyUI nginx 不转发 Upgrade 头, WS handshake 必败。
        轮询节奏: 1 Hz, 对应 history 接口每次 ~1KB, 10 并发任务 ~10 RPS — 可接受。
        进度: dummy 50% 表示 running, 不解析具体 step (用户偏好简化)。
        完成判定:
          - /queue.running 或 /queue.pending 含 prompt_id → 仍然 running
          - /history/{pid} 有该 pid 且 status_str='success' → done
          - /history/{pid} 有该 pid 且 status_str='error' → error
          - 兜底: 轮询 N 次(默认 5min) 都没结果 → timeout error
        """
        POLL_INTERVAL_S = 1.0
        TIMEOUT_S = 600.0  # 10 分钟, 覆盖最慢的 1080p/15s 任务
        deadline = time.time() + TIMEOUT_S
        in_history_first_seen = None  # 用于区分"刚开始算"还是"老 entry"

        try:
            while time.time() < deadline:
                if sub.status in ("done", "error"):
                    return

                # 1) 看 /queue
                async with ComfyUIClient() as c:
                    q = await c.get_queue()
                in_run = any(
                    (len(item) > 1 and item[1] == sub.prompt_id)
                    for item in (q.get("queue_running", []) or [])
                )
                in_pend = any(
                    (len(item) > 1 and item[1] == sub.prompt_id)
                    for item in (q.get("queue_pending", []) or [])
                )

                # 2) 看 /history/{pid}
                async with ComfyUIClient() as c:
                    h = await c.get_history_one(sub.prompt_id)
                done_info = h.get(sub.prompt_id) if isinstance(h, dict) else None

                if in_run or in_pend:
                    # 仍在队列里 → running, 发 dummy 进度
                    if sub.status == "submitted":
                        sub.status = "running"
                        # 2026-09-06: 第一次发现自己在 running 时打时间戳
                        # (用于 ETA = total - elapsed 公式, frontend 5s 刷新时用)
                        sub.running_started_at = time.time()
                        await self._emit(sub, {"type": "node_start", "node": "polling"})
                    # 用户偏好: dummy 50% 表示 running (不用真实 step 数)
                    if sub.progress != 0.5:
                        sub.progress = 0.5
                        await self._emit(sub, {
                            "type": "progress", "value": 1, "max": 2,
                            "percent": 0.5,
                        })
                    await asyncio.sleep(POLL_INTERVAL_S)
                    continue

                if done_info is not None:
                    status_str = (done_info.get("status") or {}).get("status_str")
                    if status_str == "success":
                        # 收集 outputs (ComfyUI 把 mp4 放 images, animated=True)
                        outputs = done_info.get("outputs") or {}
                        for node_id, out in outputs.items():
                            for v in (out.get("videos") or []) + (out.get("images") or []):
                                fname = v.get("filename", "")
                                if not fname:
                                    continue
                                sub.output_files.append(v)
                                await self._emit(sub, {
                                    "type": "node_output", "node": node_id,
                                    "files": sub.output_files,
                                })
                                # 触发落盘 (走 sudo 桥接 → H3_UPLOADS_DIR, 见 /etc/sudoers.d/claude)
                                if fname.endswith(".mp4"):
                                    asyncio.create_task(self._fetch_and_stage(
                                        fname, v.get("subfolder", ""), sub))
                        sub.status = "done"
                        sub.progress = 1.0
                        sub.progress_step = 1
                        sub.progress_max = 1
                        sub.finished_at = time.time()
                        await self._emit(sub, {
                            "type": "progress", "value": 1, "max": 1, "percent": 1.0,
                        })
                        # 2026-08-31: 把 web_path + 真正生成时间一并 emit,前端不需要再扫 history 拼路径
                        # (避免跨午夜、并发提交时的目录日期混乱)
                        files_with_path = []
                        for f in sub.output_files:
                            fname = f.get("filename", "")
                            if fname.endswith((".mp4", ".png", ".jpg", ".webp")):
                                # 跟 _fetch_and_stage 同样的目录决策
                                date_dir = H3_UPLOADS_DIR / time.strftime("%Y-%m-%d")
                                files_with_path.append({
                                    **f,
                                    "web_path": f"/media/{date_dir.name}/{fname}",
                                    "submitted_at": sub.submitted_at,
                                    "finished_at": sub.finished_at,
                                    "generation_sec": (
                                        round(sub.finished_at - sub.submitted_at, 1)
                                        if sub.finished_at and sub.submitted_at else None
                                    ),
                                })
                            else:
                                files_with_path.append(f)
                        await self._emit(sub, {"type": "done", "files": files_with_path})
                        log.info(f"polling done: {sub.submission_id} prompt_id={sub.prompt_id[:8]}")
                        return
                    elif status_str == "error":
                        msgs = (done_info.get("status") or {}).get("messages") or []
                        err_text = "ComfyUI task error"
                        for m in msgs:
                            if m[0] == "execution_error":
                                err_text = str(m[1].get("exception_message", err_text))[:500]
                                break
                        sub.status = "error"
                        sub.error = err_text
                        sub.finished_at = time.time()
                        await self._emit(sub, {"type": "error", "error": err_text})
                        log.warning(f"polling error: {sub.submission_id} - {err_text[:80]}")
                        return

                # 都不在: 可能是提交后第一次轮询的过渡(队列还没显示), 也可能彻底没了
                # 给 5s 缓冲期, 之后当 error
                if in_history_first_seen is None and done_info is None:
                    in_history_first_seen = time.time()
                if in_history_first_seen and time.time() - in_history_first_seen > 5:
                    sub.status = "error"
                    sub.error = "任务消失: 既不在 queue 也不在 history"
                    sub.finished_at = time.time()
                    await self._emit(sub, {"type": "error", "error": sub.error})
                    log.warning(f"polling lost: {sub.submission_id}")
                    return

                await asyncio.sleep(POLL_INTERVAL_S)

            # === timeout 兜底 (2026-09-17 Jack 反馈) ===
            # 之前: timeout 直接退出, 任务实际成功也不 stage, 视频留在 RTX output 永远丢失
            # 现在: timeout 前再查一次 history, 如果 success 就 stage + 标 done
            try:
                async with ComfyUIClient() as c:
                    hist_retry = await c.get_history(max_items=50)
                done_retry = None
                for pid_k, entry in (hist_retry or {}).items():
                    if pid_k == sub.prompt_id and entry:
                        done_retry = entry
                        break
                if done_retry is not None:
                    status_str = (done_retry.get("status") or {}).get("status_str")
                    if status_str == "success":
                        log.info(f"polling timeout but history shows success — late stage for {sub.submission_id}")
                        # 复用 done_info 处理逻辑: 触发落盘 + emit done
                        outputs = done_retry.get("outputs") or {}
                        for node_id, out in outputs.items():
                            for v in (out.get("videos") or []) + (out.get("images") or []):
                                fname = v.get("filename", "")
                                if not fname:
                                    continue
                                sub.output_files.append(v)
                                if fname.endswith(".mp4"):
                                    asyncio.create_task(self._fetch_and_stage(
                                        fname, v.get("subfolder", ""), sub))
                        sub.status = "done"
                        sub.progress = 1.0
                        sub.progress_step = 1
                        sub.progress_max = 1
                        sub.finished_at = time.time()
                        files_with_path = []
                        for f in sub.output_files:
                            fname = f.get("filename", "")
                            if fname.endswith((".mp4", ".png", ".jpg", ".webp")):
                                date_dir = H3_UPLOADS_DIR / time.strftime("%Y-%m-%d")
                                files_with_path.append({**f, "web_path": f"/media/{date_dir.name}/{fname}"})
                            else:
                                files_with_path.append(f)
                        await self._emit(sub, {"type": "done", "files": files_with_path})
                        return
            except Exception as e:
                log.warning(f"late-retry fetch_and_stage failed: {e}")

            sub.status = "error"
            sub.error = f"轮询超时 ({TIMEOUT_S}s), ComfyUI 未完成"
            sub.finished_at = time.time()
            await self._emit(sub, {"type": "error", "error": sub.error})

        except Exception as e:
            log.exception(f"track_by_polling crash for {sub.submission_id}: {e}")
            sub.status = "error"
            sub.error = f"polling crash: {str(e)[:300]}"
            sub.finished_at = time.time()
            try:
                await self._emit(sub, {"type": "error", "error": sub.error})
            except Exception:
                pass

    async def _check_done(self, sub: Submission) -> None:
        """轮询 /history 判断是否真的完成。"""
        if sub.status in ("done", "error"):
            return
        try:
            async with ComfyUIClient() as c:
                h = await c.get_history_one(sub.prompt_id)
            if h:
                sub.status = "done"
                sub.progress = 1.0
                sub.finished_at = time.time()
                await self._emit(sub, {"type": "done", "files": sub.output_files})
        except ComfyUIError:
            pass  # 下次再试

    async def _emit(self, sub: Submission, event: dict) -> None:
        """把事件推到 sub 的订阅队列。"""
        event["submission_id"] = sub.submission_id
        event["ts"] = time.time()
        try:
            sub.event_queue.put_nowait(event)
        except asyncio.QueueFull:
            log.warning(f"event queue full for {sub.submission_id}, dropping event")

    async def _fetch_and_stage(self, filename: str, subfolder: str, sub: Submission) -> None:
        """生成完成后,把 ComfyUI output 里的视频拉到 uploads 目录。

        让 sibling viewer (如 h3-video 子域) 自动看到新视频 — 通过本地 /api/refresh 触发。
        """
        import subprocess as sp
        # H3_UPLOADS_DIR 已在文件顶部 import

        try:
            date_dir = H3_UPLOADS_DIR / time.strftime("%Y-%m-%d")
            target = date_dir / filename
            if target.exists():
                log.info(f"video already staged: {target}")
                return

            # 先拉到 /tmp (hermes 可写),再通过 sudo 桥接脚本移动到共享目录
            tmp_path = Path("/tmp") / f"h3_stage_{filename}"
            async with ComfyUIClient() as c:
                async with c._session.get(
                    f"{c.base_url}/view",
                    params={"filename": filename, "subfolder": subfolder, "type": "output"},
                ) as r:
                    if r.status != 200:
                        log.warning(f"view {filename} → {r.status}")
                        return
                    with open(tmp_path, "wb") as f:
                        async for chunk in r.content.iter_chunked(1 << 20):
                            f.write(chunk)

            # sudo 桥接:hermes 可调用 root-owned stage_h3_video.sh
            res = sp.run(
                ["sudo", "-n", "/usr/local/bin/stage_h3_video.sh", str(tmp_path), filename],
                capture_output=True, text=True, timeout=30,
            )
            if res.returncode != 0:
                log.error(f"stage_h3_video.sh failed: rc={res.returncode} stderr={res.stderr[:200]}")
                tmp_path.unlink(missing_ok=True)
                return
            log.info(f"staged: {res.stdout.strip()}")

            # 抽第一帧当 cover.jpg (前端 HistoryTab modal 静态预览用)
            # 用 ffmpeg: -ss 1 跳到 1s (避开黑屏标题帧), -frames:v 1 只抽 1 帧
            cover_tmp = Path("/tmp") / f"h3_stage_{filename}.cover.jpg"
            cover_res = sp.run(
                ["ffmpeg", "-y", "-loglevel", "error",
                 "-ss", "1", "-i", str(target),
                 "-frames:v", "1",
                 "-vf", "scale=480:-2",
                 "-q:v", "3",
                 str(cover_tmp)],
                capture_output=True, text=True, timeout=15,
            )
            if cover_res.returncode == 0 and cover_tmp.exists():
                sp.run(
                    ["sudo", "-n", "cp", str(cover_tmp), str(target) + ".cover.jpg"],
                    check=False, timeout=10,
                )
                sp.run(
                    ["sudo", "-n", "chmod", "644", str(target) + ".cover.jpg"],
                    check=False, timeout=5,
                )
                cover_tmp.unlink(missing_ok=True)
                log.info(f"cover.jpg written: {target}.cover.jpg")
            else:
                log.warning(f"cover.jpg extraction failed (rc={cover_res.returncode}): {cover_res.stderr[:200]}")

            tmp_path.unlink(missing_ok=True)

            # 写 meta.json (用 sudo,因为目录是 root:root 666)
            meta = {
                "src": str(target),
                "imported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "media_type": "video",
                "category": "art",
                "subcat": f"uploads/{date_dir.name}",
                "title": f"H3 Studio · {sub.prompt_text[:60].strip()}",
                "desc": f"[H3 Studio] {sub.prompt_text}",
                "tags": ["h3", "studio", "web-ui"] + (["ref-image"] if sub.ref_image else []),
                "prompt": sub.prompt_text,
                "duration_s": sub.duration_s,
                "ref_image": sub.ref_image,  # 形如 "h3studio/<filename>.jpg" 或 None
                # 2026-08-31: 视频生成的真正开始/结束时间 + 耗时
                # epoch 浮点 (前端好算 elapsed),ISO8601 (人读友好)
                "submitted_at": sub.submitted_at,
                "finished_at": sub.finished_at,
                "submitted_at_iso": (
                    time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(sub.submitted_at))
                    if sub.submitted_at else None
                ),
                "finished_at_iso": (
                    time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(sub.finished_at))
                    if sub.finished_at else None
                ),
                "generation_sec": (
                    round(sub.finished_at - sub.submitted_at, 1)
                    if sub.finished_at and sub.submitted_at else None
                ),
            }
            meta_str = json.dumps(meta, ensure_ascii=False, indent=2)
            meta_tmp = Path("/tmp") / f"h3_stage_{filename}.meta.json"
            meta_tmp.write_text(meta_str)
            sp.run(
                ["sudo", "-n", "cp", str(meta_tmp), str(target) + ".meta.json"],
                check=True, timeout=10,
            )
            sp.run(["sudo", "-n", "chmod", "666", str(target) + ".meta.json"], check=True, timeout=5)
            meta_tmp.unlink(missing_ok=True)

            log.info(f"meta written: {target}.meta.json")

            # 同步触发 sibling viewer 服务重扫盘,这样关联的前端画廊
            # 立即能看到新视频, 不用等服务重启
            # 用 asyncio.create_task 放后台跑, 不阻塞 WS 推送
            # 如果 viewer 没运行 (URLError), 自动降级为下次重启才看到
            asyncio.create_task(self._trigger_h3_viewer_refresh())

            await self._emit(sub, {"type": "staged", "web_path": f"/media/{date_dir.name}/{filename}"})
        except Exception as e:
            log.exception(f"fetch_and_stage failed for {filename}: {e}")

    @staticmethod
    async def _trigger_h3_viewer_refresh() -> None:
        """后台异步触发 h3-viewer 重扫盘。

        放到独立线程跑,即使 h3-viewer 重扫很慢也不影响 h3-studio-api 主流程。
        h3-viewer 的 /api/refresh 是 Flask 同步,扫 200+ 视频 + 300+ BeatAPI 解析
        可能需要 10-30 秒。

        URL 从 config.H3_VIEWER_REFRESH_URL 读 (.env 覆盖), 留空则禁用联动。
        """
        import urllib.request
        from .config import H3_VIEWER_REFRESH_URL
        if not H3_VIEWER_REFRESH_URL:
            return
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: urllib.request.urlopen(
                    H3_VIEWER_REFRESH_URL,
                    timeout=60,
                ).read().decode(),
            )
            log.info("h3-viewer refreshed successfully")
        except Exception as e:
            log.warning(f"h3-viewer refresh failed (will recover on next restart): {e}")

    # ---------------------------------------------------------- 查询

    def get(self, submission_id: str) -> Optional[Submission]:
        return self._subs.get(submission_id)

    def list_recent(self, limit: int = 20) -> list[dict]:
        items = sorted(self._subs.values(), key=lambda s: -s.submitted_at)
        return [s.snapshot() for s in items[:limit]]


# 全局单例
manager = SubmitManager()

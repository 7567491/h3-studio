"""GPU 事件 WebSocket 桥接器。

架构:
  远端 ComfyUI WS ──→ ws_bridge (订阅 + 解析) ──→ 本地 asyncio.Queue ──→ /ws/gpu-events ──→ 前端

事件类型 (来自 ComfyUI):
  - status          → 队列状态 (queue_remaining, exec_info)
  - executing       → 当前在跑的节点 (node id, prompt_id)
  - progress        → sampling 进度 {value: 5/8, max: 8, prompt_id, node}
  - execution_start → 任务开始
  - execution_success → 任务成功
  - execution_error   → 任务失败

我们只关心 GPU/任务进度相关的事件, 转发给前端 QueueTab。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from base64 import b64encode

import websockets
from typing import Optional

log = logging.getLogger("h3.ws_bridge")

# === 远端 ComfyUI WS 入口 ===
# 从 .env 读: COMFYUI_BASE_URL 决定 host, 用户名/密码走 COMFYUI_USERNAME/_PASSWORD.
# ⚠️ 不再硬编码远端地址/凭据 — 默认值留空,启动时校验 .env 是否配齐。
def _build_ws_url_and_auth() -> tuple[str, str]:
    """构造 wss URL 和 Basic Auth header。空配置时返回 ('', '')。"""
    base = os.environ.get("COMFYUI_BASE_URL", "").strip()
    user = os.environ.get("COMFYUI_USERNAME", "")
    pwd = os.environ.get("COMFYUI_PASSWORD", "")
    if not base or not user or not pwd:
        return "", ""
    # base 形如 https://host:port; 转为 wss://host:port/ws?clientId=...
    ws_base = base.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    client_id = os.environ.get("COMFYUI_CLIENT_ID", "h3-studio-bridge")
    url = f"{ws_base.rstrip('/')}/ws?clientId={client_id}"
    auth = "Basic " + b64encode(f"{user}:{pwd}".encode()).decode()
    return url, auth


DEMOAKAMAI_WS_URL = ""  # 旧字段名保留以兼容可能存在的旧 import — 实际走 _ws_url()
AUTH_HEADER = ""
_ws_url_cache: str | None = None
_auth_cache: str | None = None


def _ws_url() -> str:
    global _ws_url_cache, _auth_cache
    if _ws_url_cache is None:
        _ws_url_cache, _auth_cache = _build_ws_url_and_auth()
    return _ws_url_cache


def _ws_auth() -> str:
    global _ws_url_cache, _auth_cache
    if _auth_cache is None:
        _ws_url_cache, _auth_cache = _build_ws_url_and_auth()
    return _auth_cache


# 订阅者队列 (多个前端连接共用一个远端订阅)
_subscriber_queues: list[asyncio.Queue] = []
_bridge_task: Optional[asyncio.Task] = None
_last_state: dict = {
    "status": None,
    "executing": None,  # 当前节点
    "progress": None,   # {value, max} 当前 step 进度
    "last_prompt_id": None,
}


async def _forward_to_subscribers(event: dict) -> None:
    """把事件转发给所有订阅者 (前端 WebSocket 客户端)."""
    dead = []
    for q in _subscriber_queues:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        try:
            _subscriber_queues.remove(q)
        except ValueError:
            pass


def get_last_state() -> dict:
    """获取当前 GPU 状态快照 (供新订阅者立即拉一份)."""
    return dict(_last_state)


async def subscribe() -> asyncio.Queue:
    """前端订阅: 返回一个新队列, 用于从 broker 接收事件.

    订阅者必须定期调用 get() 拿事件, 并在断开时调用 unsubscribe().
    """
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscriber_queues.append(q)
    log.info("ws_bridge: new subscriber, total=%d", len(_subscriber_queues))
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    """前端断开时调用."""
    try:
        _subscriber_queues.remove(q)
        log.info("ws_bridge: subscriber removed, total=%d", len(_subscriber_queues))
    except ValueError:
        pass


def _parse_event(raw: str) -> Optional[dict]:
    """解析一条 远端 ComfyUI WS 消息, 提取我们关心的 GPU 状态字段."""
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return None

    msg_type = msg.get("type")
    data = msg.get("data", {})

    if msg_type == "status":
        # 队列状态
        status = data.get("status", {})
        exec_info = status.get("exec_info", {})
        event = {
            "type": "queue_status",
            "queue_remaining": exec_info.get("queue_remaining", 0),
            "prompt_id": data.get("sid"),  # 不对, sid 是 client_id
        }
        # 真实 sid/prompt_id 在 executing 事件里
        return event

    elif msg_type == "executing":
        # 当前在跑的节点 (例如 "10" 是 H3 主节点)
        # data: {"node": "10", "prompt_id": "..."}
        event = {
            "type": "executing",
            "node": data.get("node"),
            "prompt_id": data.get("prompt_id"),
        }
        return event

    elif msg_type == "progress":
        # sampling step 进度
        # data: {"value": 5, "max": 8, "prompt_id": "...", "node": "..."}
        event = {
            "type": "progress",
            "step": data.get("value"),
            "max_steps": data.get("max"),
            "prompt_id": data.get("prompt_id"),
            "node": data.get("node"),
        }
        return event

    elif msg_type in ("execution_start", "execution_success", "execution_error", "execution_cached"):
        # 任务生命周期
        event = {
            "type": msg_type,
            "prompt_id": data.get("prompt_id"),
        }
        if msg_type == "execution_success":
            event["timestamp"] = data.get("timestamp")
        return event

    return None


async def _bridge_loop() -> None:
    """主循环: 订阅远端 ComfyUI WS, 解析 + 转发事件."""
    backoff = 1.0
    while True:
        url = _ws_url()
        auth = _ws_auth()
        if not url or not auth:
            log.warning(
                "ws_bridge: COMFYUI_BASE_URL/USERNAME/PASSWORD 未配置, GPU 事件桥接禁用 (60s 后重试)"
            )
            await asyncio.sleep(60.0)
            continue
        try:
            log.info("ws_bridge: connecting to %s", url)
            async with websockets.connect(
                url,
                extra_headers={"Authorization": auth},
                ping_interval=None,
            ) as ws:
                log.info("ws_bridge: connected")
                backoff = 1.0
                # 立即发一个 status 请求, 拿初始队列状态
                try:
                    await ws.send(json.dumps({"type": "subscribe", "event_types": ["status", "executing", "progress"]}))
                except Exception:
                    pass
                async for raw in ws:
                    evt = _parse_event(raw)
                    if evt is None:
                        continue
                    # 更新 last_state
                    if evt["type"] == "executing":
                        _last_state["executing"] = evt
                        _last_state["last_prompt_id"] = evt.get("prompt_id")
                    elif evt["type"] == "progress":
                        _last_state["progress"] = evt
                    elif evt["type"] == "queue_status":
                        _last_state["status"] = evt
                    # 转发给所有前端订阅者
                    await _forward_to_subscribers(evt)
        except Exception as e:
            log.warning("ws_bridge: connection error %s, retry in %.1fs", e, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


async def start() -> None:
    """FastAPI startup 时调用: 启动后台 WS 桥接任务."""
    global _bridge_task
    if _bridge_task and not _bridge_task.done():
        log.info("ws_bridge: already running")
        return
    _bridge_task = asyncio.create_task(_bridge_loop())
    log.info("ws_bridge: started")


async def stop() -> None:
    """FastAPI shutdown 时调用: 取消后台任务."""
    global _bridge_task
    if _bridge_task and not _bridge_task.done():
        _bridge_task.cancel()
        try:
            await _bridge_task
        except (asyncio.CancelledError, Exception):
            pass
        log.info("ws_bridge: stopped")

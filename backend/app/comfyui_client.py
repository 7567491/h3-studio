"""ComfyUI 客户端:封装 REST + WebSocket。

设计原则:
- 全部 async,绝不阻塞 FastAPI event loop
- WebSocket 上行/下行消息统一包装为 asyncio.Queue
- 连接失败要快速抛出,不要静默重试
"""
import asyncio
import json
import logging
from typing import AsyncIterator, Optional

import aiohttp
from aiohttp import ClientSession, ClientWebSocketResponse, WSMsgType

from .config import COMFYUI_AUTH_HEADER, COMFYUI_BASE_URL

log = logging.getLogger("h3.comfyui_client")


class ComfyUIError(Exception):
    """ComfyUI 调用相关错误的统一基类。"""


class ComfyUIClient:
    """异步 ComfyUI 客户端。

    用法:
        async with ComfyUIClient() as c:
            queue = await c.get_queue()
            await c.submit(prompt=workflow, client_id="abc")
            async for msg in c.ws_listen("abc"):
                print(msg)
    """

    def __init__(self, base_url: str = COMFYUI_BASE_URL, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = aiohttp.ClientTimeout(total=timeout)
        self._session: Optional[ClientSession] = None

    async def __aenter__(self) -> "ComfyUIClient":
        self._session = aiohttp.ClientSession(
            timeout=self.timeout,
            headers={"Authorization": COMFYUI_AUTH_HEADER},
        )
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._session:
            await self._session.close()

    # ------------------------------------------------------------------ REST

    async def _get(self, path: str) -> dict:
        assert self._session, "must use 'async with'"
        url = f"{self.base_url}{path}"
        try:
            async with self._session.get(url) as r:
                if r.status == 401:
                    raise ComfyUIError(f"401 Unauthorized — check Basic Auth for {path}")
                if r.status != 200:
                    text = await r.text()
                    raise ComfyUIError(f"GET {path} → {r.status}: {text[:300]}")
                return await r.json()
        except asyncio.TimeoutError:
            raise ComfyUIError(f"GET {path} timed out after {self.timeout.total}s")

    async def upload_image(
        self, filename: str, data: bytes, content_type: str = "image/jpeg",
        subfolder: str = "", overwrite: bool = False,
    ) -> dict:
        """POST /upload/image (multipart) 把图片上传到 ComfyUI input 目录。

        返回 {"name": filename, "subfolder": subfolder, "type": "input"}。
        ComfyUI 字段名约定: file field 是 'image', form 字段 'type'='input',
        'subfolder' 可选, 'overwrite' 可选。
        """
        import aiohttp
        assert self._session, "must use 'async with'"
        url = f"{self.base_url}/upload/image"
        # data (form 字段) + data (  multipart 二进制)
        # aiohttp FormData 会从 data dict 生成 form 字段, file 字段单独传
        form = aiohttp.FormData()
        form.add_field("type", "input")
        if subfolder:
            form.add_field("subfolder", subfolder)
        form.add_field("overwrite", "true" if overwrite else "false")
        form.add_field(
            "image",
            data,
            filename=filename,
            content_type=content_type,
        )
        try:
            async with self._session.post(url, data=form) as r:
                if r.status == 401:
                    raise ComfyUIError(f"401 Unauthorized uploading to {subfolder}/{filename}")
                if r.status >= 400:
                    text = await r.text()
                    raise ComfyUIError(f"upload_image → {r.status}: {text[:300]}")
                return await r.json()
        except asyncio.TimeoutError:
            raise ComfyUIError(f"upload_image timed out after {self.timeout.total}s")

    async def _post(self, path: str, data: dict) -> dict:
        assert self._session, "must use 'async with'"
        url = f"{self.base_url}{path}"
        try:
            async with self._session.post(url, json=data) as r:
                body = await r.json(content_type=None)
                if r.status >= 400:
                    raise ComfyUIError(f"POST {path} → {r.status}: {body}")
                return body
        except asyncio.TimeoutError:
            raise ComfyUIError(f"POST {path} timed out after {self.timeout.total}s")

    async def health_check(self) -> bool:
        """快速探测 ComfyUI 是否在线。"""
        try:
            await self._get("/system_stats")
            return True
        except ComfyUIError:
            return False

    async def get_system_stats(self) -> dict:
        """/system_stats → GPU/内存/版本。"""
        return await self._get("/system_stats")

    async def get_queue(self) -> dict:
        """/queue → {queue_running, queue_pending}"""
        return await self._get("/queue")

    async def get_history(self, max_items: int = 50) -> dict:
        """/history → {prompt_id: {prompt, outputs, status}}"""
        return await self._get(f"/history?max_items={max_items}")

    async def get_history_one(self, prompt_id: str) -> dict:
        return await self._get(f"/history/{prompt_id}")

    async def submit(self, prompt: dict, client_id: str) -> str:
        """POST /prompt 提交工作流,返回 prompt_id。

        ComfyUI 客户端必须先用 client_id 建立 WS 连接监听进度,
        否则提交后会一直占着队列无人接。
        """
        body = {"prompt": prompt, "client_id": client_id}
        resp = await self._post("/prompt", body)
        if "prompt_id" not in resp:
            raise ComfyUIError(f"submit 返回无 prompt_id: {resp}")
        return resp["prompt_id"]

    async def interrupt(self) -> dict:
        """POST /interrupt 中断当前任务。"""
        return await self._post("/interrupt", {})

    # ------------------------------------------------------------------ WS

    async def ws_listen(self, client_id: str) -> AsyncIterator[dict]:
        """建立 WS 连接 /ws?clientId=xxx,产出每条 JSON 消息。

        重要消息类型:
        - {type: "status", data: {status: {exec_info: {queue_remaining: N}}}}
        - {type: "executing", data: {node: "50", prompt_id: "xxx"}}
        - {type: "progress", data: {value, max, node: "50", prompt_id: "xxx"}}
        - {type: "executed", data: {node: ..., output: ..., prompt_id: "xxx"}}
        - {type: "execution_error", data: {...}}
        """
        url = f"{self.base_url.replace('http', 'ws', 1)}/ws?clientId={client_id}"
        # WS 的 Authorization 要在子协议或 query 传,aiohttp WS 默认支持 header
        async with self._session.ws_connect(url, autoclose=False) as ws:
            log.info(f"WS connected: client_id={client_id}")
            async for raw in ws:
                if raw.type == WSMsgType.TEXT:
                    try:
                        msg = json.loads(raw.data)
                    except json.JSONDecodeError:
                        log.warning(f"WS 非 JSON 消息: {raw.data[:200]}")
                        continue
                    yield msg
                elif raw.type == WSMsgType.ERROR:
                    raise ComfyUIError(f"WS error: {ws.exception()}")
                elif raw.type in (WSMsgType.CLOSE, WSMsgType.CLOSED):
                    log.info(f"WS closed: client_id={client_id}")
                    break

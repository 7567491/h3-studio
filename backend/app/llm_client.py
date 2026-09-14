"""通用 LLM 客户端 — 支持 OpenAI 兼容协议 + Anthropic native + 自定义 endpoint。

支持的 provider:
  - openai    : OpenAI 兼容协议 (OpenAI, DeepSeek, Ollama, vLLM, lm-studio, MiniMax-M3 等)
  - anthropic : Anthropic native (claude-3.5-sonnet, claude-opus-4 等)
  - custom    : 与 openai 兼容,但 base_url 完全自定义 (给私有部署用)

每个调用入口:
  - chat_vision(messages, model=None)  → str  (返回文本)
  - chat_text(messages, model=None, max_tokens=16000)  → str

配置 (env var,优先级降序):
  1. 系统环境变量 (生产推荐)
  2. backend/.env (由 config.py / dotenv 加载)
  3. ~/.hermes/.env (Hermes Agent 同机部署兜底,只识别 MINIMAX_CN_API_KEY)

向后兼容:
  - MINIMAX_CN_API_KEY → LLM_API_KEY
  - MINIMAX_CN_BASE_URL → LLM_BASE_URL (默认 https://api.minimaxi.com/v1)
  - 不写 LLM_PROVIDER 时,如 base_url 形如 minimaxi.com → 视为 openai 兼容协议
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

log = logging.getLogger("h3.llm_client")


# === 配置加载 ===

# Hermes Agent 同机部署兜底路径(只对历史 MINIMAX_CN_* 键生效)
_HERMES_ENV = Path.home() / ".hermes" / ".env"

# 默认值 — 选 OpenAI 是因为 (a) 业界最广泛兼容 (b) clone 用户最常有的 key
# ⚠️ 部署时必须在 backend/.env 显式设 LLM_BASE_URL (或 LLM_API_KEY)，否则会以这个默认 base 发出请求。
_DEFAULTS = {
    "provider": "openai",          # openai / anthropic / custom
    "base_url": "https://api.openai.com/v1",
    "vision_model": "",            # 留空 = 禁用 vision
    "text_model": "",              # 必填(调用时才校验)
    "max_tokens_default": 16000,
}


def _load_env_with_fallback() -> dict[str, str]:
    """从多源加载 LLM 配置。

    优先级:
      1) 显式 LLM_* env var
      2) 旧 MINIMAX_CN_* env var(向后兼容 Hermes Agent)
      3) ~/.hermes/.env (Hermes Agent 同机部署兜底)
    """
    cfg = {}

    # 1) 显式 LLM_*
    cfg["provider"] = os.environ.get("LLM_PROVIDER", _DEFAULTS["provider"]).strip().lower()
    cfg["base_url"] = os.environ.get("LLM_BASE_URL", "").strip() or _DEFAULTS["base_url"]
    cfg["api_key"] = os.environ.get("LLM_API_KEY", "").strip()
    cfg["vision_model"] = os.environ.get("LLM_VISION_MODEL", "").strip()
    cfg["text_model"] = os.environ.get("LLM_TEXT_MODEL", "").strip()
    cfg["vision_endpoint"] = os.environ.get("LLM_VISION_ENDPOINT", "").strip()
    cfg["text_endpoint"] = os.environ.get("LLM_TEXT_ENDPOINT", "").strip()

    # 2) 旧 MINIMAX_CN_* 兼容(只在 LLM_* 未设时生效)
    legacy_key = os.environ.get("MINIMAX_CN_API_KEY", "").strip()
    legacy_base = os.environ.get("MINIMAX_CN_BASE_URL", "").strip()
    if legacy_key and not cfg["api_key"]:
        cfg["api_key"] = legacy_key
        log.info("llm_client: loaded MINIMAX_CN_API_KEY (legacy) → LLM_API_KEY")
    if legacy_base and not os.environ.get("LLM_BASE_URL"):
        cfg["base_url"] = legacy_base.rstrip("/")

    # 3) Hermes Agent ~/.hermes/.env 兜底
    if (not cfg["api_key"]) and _HERMES_ENV.exists():
        for line in _HERMES_ENV.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k == "MINIMAX_CN_API_KEY" and not cfg["api_key"]:
                cfg["api_key"] = v.strip()
                log.info("llm_client: loaded MINIMAX_CN_API_KEY from ~/.hermes/.env")
            elif k == "MINIMAX_CN_BASE_URL" and not os.environ.get("LLM_BASE_URL") and not cfg["base_url"]:
                if "anthropic" not in v:
                    cfg["base_url"] = v.strip().rstrip("/")

    return cfg


# 缓存 cfg(单进程内不变)
_CFG_CACHE: dict[str, str] | None = None


def get_config() -> dict[str, str]:
    """获取当前 LLM 配置(只读 cache)。"""
    global _CFG_CACHE
    if _CFG_CACHE is None:
        _CFG_CACHE = _load_env_with_fallback()
    return dict(_CFG_CACHE)


def reset_config_cache() -> None:
    """测试用:重置配置缓存(改 env 后重新加载)。"""
    global _CFG_CACHE
    _CFG_CACHE = None


def is_configured() -> bool:
    """是否配置了足够调用 chat_text 的最低要求(api_key + text_model)。"""
    cfg = get_config()
    return bool(cfg.get("api_key")) and bool(cfg.get("text_model"))


# === HTTP 抽象 ===

def _post(url: str, headers: dict, payload: dict, timeout: int = 180) -> dict:
    """统一 POST:返回 parsed JSON dict。"""
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        try:
            return json.loads(resp.read())
        finally:
            try:
                resp.close()
            except Exception:
                pass
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        raise RuntimeError(f"LLM API HTTP {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"LLM API unreachable: {e}") from e


# === OpenAI 兼容协议 ===

def _openai_chat(messages: list[dict], model: str, max_tokens: int, cfg: dict, timeout: int) -> str:
    """OpenAI 兼容协议的 chat/completions 调用。

    支持 endpoint override: cfg["text_endpoint"] 或 cfg["vision_endpoint"]
    默认 {base_url}/chat/completions
    """
    endpoint = cfg.get("text_endpoint") or "chat/completions"
    url = f"{cfg['base_url'].rstrip('/')}/{endpoint.lstrip('/')}"
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.7,
    }
    result = _post(url, headers, payload, timeout)
    try:
        return result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"LLM response missing choices[0].message.content: {result}") from e


# === Anthropic native 协议 ===

def _anthropic_chat(messages: list[dict], model: str, max_tokens: int, cfg: dict, timeout: int) -> str:
    """Anthropic /v1/messages native 调用。

    注意: Anthropic 协议下, system message 必须单独作为 `system` 字段,不能放在 messages 数组里。
    """
    endpoint = cfg.get("text_endpoint") or "v1/messages"
    url = f"{cfg['base_url'].rstrip('/')}/{endpoint.lstrip('/')}"
    headers = {
        "x-api-key": cfg["api_key"],
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }

    # 拆分 system vs messages
    system_parts: list[str] = []
    converted: list[dict] = []
    for m in messages:
        if m["role"] == "system":
            system_parts.append(m["content"])
        else:
            converted.append(m)

    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": 0.7,
        "messages": converted,
    }
    if system_parts:
        payload["system"] = "\n\n".join(system_parts)

    result = _post(url, headers, payload, timeout)
    try:
        # Anthropic 返回 content 是 list of blocks
        content = result["content"]
        if isinstance(content, list):
            # 提取 type=text 的 block
            text_blocks = [b["text"] for b in content if b.get("type") == "text"]
            return "\n".join(text_blocks) if text_blocks else str(content)
        return content
    except (KeyError, TypeError) as e:
        raise RuntimeError(f"Anthropic response missing content: {result}") from e


# === 公共入口 ===

def _do_chat(messages: list[dict], model: str, max_tokens: int, timeout: int) -> str:
    """根据 provider 选择协议。"""
    cfg = get_config()
    provider = cfg.get("provider", "openai")

    if provider in ("openai", "custom"):
        return _openai_chat(messages, model, max_tokens, cfg, timeout)
    elif provider == "anthropic":
        return _anthropic_chat(messages, model, max_tokens, cfg, timeout)
    else:
        raise RuntimeError(f"unknown LLM_PROVIDER: {provider!r}")


def chat_text(
    user_or_messages=None,
    *,
    messages: Optional[list] = None,
    model: Optional[str] = None,
    max_tokens: int = 16000,
    system: Optional[str] = None,
    timeout: int = 240,
) -> str:
    """文本扩写主入口。三种调用风格:

    风格 1(简单)
        chat_text("hello world", system="You are helpful")

    风格 2(OpenAI 风格,完整 messages,位置参数)
        chat_text([
            {"role": "system", "content": "..."},
            {"role": "user", "content": "..."},
        ])

    风格 3(OpenAI 风格,完整 messages,关键字)
        chat_text(messages=[{"role": "user", "content": "..."}], max_tokens=100)

    Returns:
        str,LLM 回复文本(不含 thinking)
    """
    cfg = get_config()

    if not cfg.get("api_key"):
        raise RuntimeError(
            "LLM_API_KEY 未配置。请在 backend/.env 设 LLM_API_KEY + LLM_BASE_URL + LLM_TEXT_MODEL "
            "(或 export 环境变量)。"
        )

    use_model = model or cfg.get("text_model")
    if not use_model:
        raise RuntimeError(
            "LLM_TEXT_MODEL 未配置。请在 backend/.env 设 LLM_TEXT_MODEL (例如 gpt-4o, claude-3-5-sonnet-latest)。"
        )

    # 构造 messages — 支持位置 / 关键字 / 字符串
    if messages is not None:
        msg_list = list(messages)
    elif isinstance(user_or_messages, str):
        msg_list = []
        if system:
            msg_list.append({"role": "system", "content": system})
        msg_list.append({"role": "user", "content": user_or_messages})
    elif user_or_messages is not None:
        msg_list = list(user_or_messages)
    else:
        raise ValueError("chat_text 需要 user 字符串 或 messages 列表")

    raw = _do_chat(msg_list, use_model, max_tokens, timeout)
    return _strip_thinking(raw)


def chat_vision(
    image_bytes: bytes,
    prompt: str,
    *,
    model: Optional[str] = None,
    mime_type: str = "image/jpeg",
    max_tokens: int = 500,
    timeout: int = 180,
) -> str:
    """Vision 调用(参考图描述)。

    支持:
        - OpenAI 兼容:image_url data URL
        - Anthropic: image source (base64)
        - 其他:假定 OpenAI 兼容
    """
    cfg = get_config()

    if not cfg.get("api_key"):
        raise RuntimeError("LLM_API_KEY 未配置,无法调用 vision API。")

    use_model = model or cfg.get("vision_model")
    if not use_model:
        raise RuntimeError(
            "LLM_VISION_MODEL 未配置。在 .env 设 LLM_VISION_MODEL (例如 gpt-4o, claude-3-5-sonnet-latest) "
            "即可启用参考图描述。留空 = 禁用 vision,前端降级为 T2VA。"
        )

    provider = cfg.get("provider", "openai")
    img_b64 = base64.b64encode(image_bytes).decode("ascii")

    if provider == "anthropic":
        # Anthropic 协议: messages 里 image 用 source.type=base64
        endpoint = cfg.get("vision_endpoint") or "v1/messages"
        url = f"{cfg['base_url'].rstrip('/')}/{endpoint.lstrip('/')}"
        headers = {
            "x-api-key": cfg["api_key"],
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        payload = {
            "model": use_model,
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": img_b64,
                        },
                    },
                ],
            }],
        }
        result = _post(url, headers, payload, timeout)
        try:
            content = result["content"]
            if isinstance(content, list):
                text_blocks = [b["text"] for b in content if b.get("type") == "text"]
                raw = "\n".join(text_blocks) if text_blocks else ""
            else:
                raw = content
        except (KeyError, TypeError) as e:
            raise RuntimeError(f"Anthropic vision response missing content: {result}") from e
    else:
        # OpenAI 兼容(image_url data URL)
        endpoint = cfg.get("vision_endpoint") or "chat/completions"
        url = f"{cfg['base_url'].rstrip('/')}/{endpoint.lstrip('/')}"
        headers = {
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": use_model,
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {
                        "url": f"data:{mime_type};base64,{img_b64}",
                    }},
                ],
            }],
        }
        result = _post(url, headers, payload, timeout)
        try:
            raw = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as e:
            raise RuntimeError(f"vision response missing choices[0].message.content: {result}") from e

    cleaned = _strip_thinking(raw)
    if not cleaned:
        raise RuntimeError("vision returned empty after stripping thinking")
    return cleaned


# === Thinking 块清洗(协议无关)===

_THINKING_RE = re.compile(
    r"<(?:think|thinking|reasoning|antml:thinking)>.*?</(?:think|thinking|reasoning|antml:thinking)>",
    re.DOTALL | re.IGNORECASE,
)


def _strip_thinking(text: str) -> str:
    """从 LLM 输出剥掉 thinking 块(M3 / Claude / o1 都可能产生)。"""
    if not isinstance(text, str):
        text = str(text)
    return _THINKING_RE.sub("", text).strip()
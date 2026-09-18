"""H3 Studio 后端配置。

所有可调参数集中在这里,改动不需要碰代码逻辑。

Secrets 通过 backend/.env 加载 (git-ignored). 复制 .env.example → .env
并填入真实值。所有 os.environ.get(...) 都从 .env 或系统 env 读。
"""
import hashlib
import os
from pathlib import Path
from base64 import b64encode

# 加载 backend/.env (相对此文件的上一级)
try:
    from dotenv import load_dotenv
    _ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
    if _ENV_PATH.exists():
        load_dotenv(_ENV_PATH, override=False)
except ImportError:
    pass  # dotenv not installed; rely on system env vars


# === ComfyUI 后端 ===
# No fallback default — must come from .env. Empty string forces config error.
COMFYUI_BASE_URL = os.environ.get("COMFYUI_BASE_URL", "")
COMFYUI_USERNAME = os.environ.get("COMFYUI_USERNAME", "")
COMFYUI_PASSWORD = os.environ.get("COMFYUI_PASSWORD", "")
COMFYUI_AUTH_HEADER = (
    "Basic " + b64encode(f"{COMFYUI_USERNAME}:{COMFYUI_PASSWORD}".encode()).decode()
)

# === 访问控制 ===
# 提交鉴权口令(用户首次访问要输入),从 .env 读
H3_ACCESS_PASS = os.environ.get("H3_ACCESS_PASS", "")
# 口令 SHA256,前端提交时也发 sha256,后端比对(避免明文在网络/日志里)
H3_ACCESS_PASS_HASH = hashlib.sha256(H3_ACCESS_PASS.encode()).hexdigest()

# 提交者白名单 (Jack 飞书 user_id 或本系统用户名)
ALLOWED_SUBMITTERS = {
    s.strip() for s in os.environ.get("H3_ALLOWED_SUBMITTERS", "").split(",") if s.strip()
}

# 速率限制:每个 IP 每 N 秒最多 1 个提交
SUBMIT_RATE_LIMIT_SECONDS = int(os.environ.get("H3_RATE_LIMIT", "300"))

# === H3 workflow 默认参数 (跟 run_one.sh 保持一致) ===
H3_DEFAULTS = {
    "unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "video_vae": "minimax_h3_video_vae_fp16.safetensors",
    "audio_vae": "minimax_h3_audio_vae_fp32.safetensors",
    "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "clip_type": "minimax",
    "ref_image_size": "match",
    "width": 832,
    "height": 480,
    "shift_video": 12.0,
    "shift_audio": 3.0,
    "scheduler": "simple",
    "steps": 8,
    "cfg": 1.0,
    "denoise": 1.0,
    "turbo_lora": "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
    "turbo_strength": 1.0,
    "low_vram": False,
    "default_seed": 42,
    "fps": 24,
    "frames_per_block": 17,
}

# === 分辨率预设 ===
# ComfyUI ReferenceToVideo 节点约束: width/height 必须 32 对齐 (step=32)
# 注意: 标准 720p (1280x720) 和 1080p (1920x1080) 都不是 32 倍数
# (720%32=16, 1080%32=24), 所以用最接近的 32 对齐替代:
# - 480p 保持 832x480 (已是 32 倍数, ratio=1.733)
# - 720p 用 1280x736 (ratio=1.739, 略瘦于 16:9, 肉眼几乎不可见)
# - 1080p 用 1920x1088 (ratio=1.765, 几乎完美 16:9)
# 像素倍数: 480p 1x → 720p 2.4x → 1080p 5.2x
# 显存粗估 (136帧): 480p~8GB / 720p~18GB / 1080p~40GB
RESOLUTION_PRESETS = {
    "480p":  (832,  480),   # 当前线上默认值, 已验证
    "720p":  (1280, 736),   # 接近 720p 实际像素 1280x720
    "1080p": (1920, 1088),  # 接近 1080p 实际像素 1920x1080
}

# === 本机文件系统 ===
# 默认相对路径 (推到 GitHub 后别人 clone 直接可用),生产环境通过 .env 覆盖为绝对路径
_PROMPTS_DEFAULT = Path(__file__).resolve().parent.parent / "prompts"
_UPLOADS_DEFAULT = Path(__file__).resolve().parent.parent / "uploads"
PROMPT_LIBRARY_DIR = Path(os.environ.get("PROMPT_LIBRARY_DIR", str(_PROMPTS_DEFAULT)))
H3_UPLOADS_DIR = Path(os.environ.get("H3_UPLOADS_DIR", str(_UPLOADS_DEFAULT)))

# === 服务 ===
SERVICE_HOST = os.environ.get("SERVICE_HOST", "127.0.0.1")
SERVICE_PORT = int(os.environ.get("SERVICE_PORT", "18893"))

# === GPU 真实状态采集 (SSH 出站到远端 RTX 服务器) ===
# 后端每 5s SSH 一次拿 nvidia-smi + vLLM API, 不用 nginx 暴露, 私钥路径安全。
# ⚠️ 部署时必填 RTX_SSH_HOST / RTX_SSH_USER,默认值留空避免泄露内网拓扑。
RTX_SSH_HOST = os.environ.get("RTX_SSH_HOST", "")
RTX_SSH_USER = os.environ.get("RTX_SSH_USER", "")
# 密码: 含 @ 必须从 .env 读, 不要明文写代码
RTX_SSH_PASS = os.environ.get("RTX_SSH_PASS", "")
# 优先用 key (skill 推荐); 没设就用密码
RTX_SSH_KEY = os.environ.get("RTX_SSH_KEY", "")
# vLLM OpenAI API endpoint (从 RTX 主机拉,本机访问用 127.0.0.1)
RTX_VLLM_API_HOST = os.environ.get("RTX_VLLM_API_HOST", "http://127.0.0.1:8000")
# 单次 SSH 超时 (前端 5s 刷新, 不能更长)
RTX_SSH_TIMEOUT_S = int(os.environ.get("RTX_SSH_TIMEOUT_S", "5"))

# === Sibling viewer 联动 ===
# 视频 stage 后, 后台异步 POST 这个 URL 触发 h3-viewer 重扫盘
# (Flask /api/refresh, 10-30s 同步扫盘, 不能阻塞主流程所以走 run_in_executor)
# 留空 = 禁用联动 (clone 此仓但没跑 h3-viewer 的部署不会刷 warning)
H3_VIEWER_REFRESH_URL = os.environ.get(
    "H3_VIEWER_REFRESH_URL", "http://127.0.0.1:18891/api/refresh"
)

# === CORS ===
# ⚠️ 部署时必须修改 — 默认留空(任何人 clone 都需要在 backend/.env 设 CORS_ORIGINS)
# 前端是同源部署, 不需要 CORS (nginx 反代下 /api/ 和 /ws/ 都通过同源访问)
# 但开发时 vite dev server 在 3000/4173, 需要放行。
#
# 后端启动时如果 CORS_ORIGINS 为空, fallback 到 ["http://localhost:3000", "http://127.0.0.1:3000"]
# (仅本机开发), 生产环境必须显式设为你自己的前端域名。

import os as _os

_DEFAULT_DEV_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]


def _parse_cors_origins() -> list[str]:
    raw = _os.environ.get("CORS_ORIGINS", "").strip()
    if raw:
        return [o.strip() for o in raw.split(",") if o.strip()]
    return list(_DEFAULT_DEV_ORIGINS)


CORS_ORIGINS = _parse_cors_origins()
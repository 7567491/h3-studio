# H3 Studio · H3 视频生成 Web Studio

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/7567491/h3-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/7567491/h3-studio/actions/workflows/ci.yml)
[![Python 3.11](https://img.shields.io/badge/python-3.11-blue.svg)](https://www.python.org/downloads/)
[![Node 20](https://img.shields.io/badge/node-20-green.svg)](https://nodejs.org/)

> **English** · **中文**

---

## 中文 (zh-CN)

通过 ComfyUI (RTX PRO 6000) 生成 MiniMax H3 reference-to-video 内容的 Web 控制台。
后端 FastAPI + 前端 React/Vite,可作为独立项目部署或与现有 ComfyUI 实例对接。

### 项目结构 / Project layout

```
h3-studio/
├── backend/                # FastAPI 后端 (Python 3.11)
│   ├── app/
│   │   ├── main.py         # FastAPI 入口 + 26 routes
│   │   ├── config.py       # 配置 (从 .env 加载)
│   │   ├── comfyui_client.py
│   │   ├── submit_manager.py
│   │   ├── workflow_builder.py
│   │   ├── expand_prompt.py
│   │   ├── prompt_library.py
│   │   ├── ws_bridge.py
│   │   ├── history_scanner.py
│   │   ├── orphan_recovery.py
│   │   └── gpu_history.py
│   ├── requirements.txt
│   ├── .env.example        # 配置模板 (可推 GitHub)
│   └── .env                # 真实凭据 (git-ignored)
│
├── frontend/               # React 18 + Vite + TS + Tailwind
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── components/     # PassGate, ProgressCard
│   │   ├── tabs/           # GenerateTab, HistoryTab, QueueTab
│   │   └── lib/            # api.ts, ws.ts, activeSub.ts
│   ├── vite.config.ts
│   ├── package.json
│   └── tailwind.config.js
│
├── .github/workflows/ci.yml  # 后端 import + 前端 tsc + build
├── .gitignore
├── LICENSE                  # Apache-2.0
└── README.md
```

### 前置条件

- **Python 3.11** (后端) / **Node.js 18+** (前端)
- 一个可访问的 **ComfyUI 实例**,跑着 MiniMax H3 模型套件:
  - `minimax_h3_fl2va_pruned_int8_convrot.safetensors` (UNET)
  - `minimax_h3_video_vae_fp16.safetensors` (视频 VAE)
  - `minimax_h3_audio_vae_fp32.safetensors` (音频 VAE)
  - `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (CLIP)
  - `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` (Turbo LoRA)

> **模型文件是 MiniMax Inc. 财产** — 见 [License](#许可证--license) 章节。

### 安装与启动 / Installation

```bash
git clone https://github.com/7567491/h3-studio
cd h3-studio

# 后端
cp backend/.env.example backend/.env
$EDITOR backend/.env   # 必填: COMFYUI_BASE_URL / _USERNAME / _PASSWORD / H3_ACCESS_PASS
chmod 600 backend/.env

cd backend
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 18893 --log-level info

# 前端 (另开终端)
cd ../frontend
npm install
npm run dev   # http://localhost:4173
```

健康检查: <http://127.0.0.1:18893/api/health> 应返回 `{"ok":true}`。
ComfyUI 连接检查: <http://127.0.0.1:18893/api/comfyui/status> 应返回 GPU 信息。

### 视频存储 (解耦) / Video storage (decoupled)

生成视频落到 `H3_UPLOADS_DIR`(可在 `.env` 改,默认 `./uploads`)。

**前端访问**:通过 nginx `/media/` location alias 到 `H3_UPLOADS_DIR`。**example nginx vhost**:

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.example;

    root /path/to/h3-studio/frontend/dist;
    index index.html;

    # 视频直读 (历史页 HistoryTab 用)
    location /media/ {
        alias /path/to/H3_UPLOADS_DIR/;   # ← 替换成你自己的路径
        add_header Cache-Control "public, max-age=86400";
    }

    # API / WS 反代
    location /api/ {
        proxy_pass http://127.0.0.1:18893;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 600s;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:18893;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

**支持任意存储后端**:
- 本地目录 (默认)
- S3FS 挂载 (例 `H3_UPLOADS_DIR=/mnt/s3fs/h3-uploads`)
- NFS / GlusterFS / CephFS
- MinIO bucket (用 rclone mount)

只需保证:
1. `hermes` 用户(或后端运行用户)对路径有读权限
2. nginx worker 用户对路径有读权限
3. 落盘脚本 (`/usr/local/bin/stage_h3_video.sh`) 对路径有写权限

### 配置 (`backend/.env`)

| Key | 说明 | 示例 |
|---|---|---|
| `COMFYUI_BASE_URL` | ComfyUI 服务地址 | `https://your-comfyui-host:8448` |
| `COMFYUI_USERNAME` | ComfyUI Basic Auth 用户名 | — |
| `COMFYUI_PASSWORD` | ComfyUI Basic Auth 密码 | — |
| `H3_ACCESS_PASS` | 前端 PassGate 口令 | — |
| `H3_UPLOADS_DIR` | 视频上传目录(任意路径) | `/var/lib/h3-uploads` |
| `LLM_PROVIDER` | `openai` / `anthropic` / `custom` | `openai` |
| `LLM_BASE_URL` | LLM API base | — |
| `LLM_API_KEY` | LLM 鉴权 key | — |
| `LLM_TEXT_MODEL` | 文本扩写模型 | `gpt-4o` |
| `RTX_SSH_HOST` | (可选)远端 GPU SSH host | — |
| `CORS_ORIGINS` | 逗号分隔允许跨域源 | `https://your-domain.example` |

完整列表见 `backend/.env.example`。

### 架构 / Architecture

```
浏览器 (your-domain.example)
    ↓
nginx 443 (TLS + 反代)
    ├─ /         → h3-studio/frontend/dist     (静态 SPA)
    ├─ /media/   → H3_UPLOADS_DIR              (历史视频 .mp4 直读)
    ├─ /api/     → 127.0.0.1:18893             (FastAPI)
    └─ /ws/      → 127.0.0.1:18893 Upgrade    (WebSocket GPU 事件)

FastAPI (18893)
    ├─ ws_bridge.py        → wss://<COMFYUI_HOST>/ws   (进度订阅)
    ├─ comfyui_client.py   → POST https://<COMFYUI_HOST>/prompt
    ├─ gpu_processes.py    → SSH nvidia-smi 真实 GPU 状态
    ├─ gpu_history.py      → 每 5s 采样显存 → JSONL
    ├─ submit_manager.py   → 长任务 polling + stage
    └─ expand_prompt.py    → LLM 扩写 prompt
```

### 已知坑 / Known issues

- **重启卡住**: systemd restart 时 `uvicorn` 等 `orphan_recovery` 完成, 通常 5-8 秒
- **prompt 库默认指向 `/tmp/beatapi_repo/prompts`**: 容器清空后会丢, 生产请在 `.env` 覆盖为持久目录
- **nginx `/media/` 别名不要加 `types{}` default_type**: 会把 `.cover.jpg` 强制成 `video/mp4`

### Patch SOP / 修改代码流程

```bash
# 1. 改代码
cd h3-studio
# 改 backend/app/*.py 或 frontend/src/**

# 2. 后端改完
cd backend
.venv/bin/python -c "from app.main import app; print('OK')"
sudo systemctl restart h3-studio-api
sleep 2
journalctl -u h3-studio-api -n 20 | grep '\[BUILD\]'  # 验 reload 成功

# 3. 前端改完
cd frontend
npm run build  # 产物在 dist/, nginx serve 即生效
```

详细 RCA 案例见 git log。

---

## English (en-US)

Web console for generating MiniMax H3 reference-to-video content via ComfyUI (RTX PRO 6000).
FastAPI backend + React/Vite frontend. Deployable standalone or alongside an existing ComfyUI instance.

### Features

- **PassGate** password authentication (SHA256)
- **Generate tab**: prompt input + reference image upload + submit
- **Queue tab**: live GPU/ComfyUI status (5s refresh, WebSocket updates)
- **History tab**: video grid + optional sibling gallery link
- **Backend**: 26 FastAPI routes (auth, generate, history, queue, GPU events)
- **Generic LLM client**: OpenAI-compatible / Anthropic native / custom endpoint
- **Polling fallback**: handles long tasks when ComfyUI WS handshake fails (nginx strips it)
- **Orphan recovery**: catches videos staged but lost on restart

### Install & run

```bash
git clone https://github.com/7567491/h3-studio
cd h3-studio

# Backend
cp backend/.env.example backend/.env
$EDITOR backend/.env   # Required: COMFYUI_BASE_URL / _USERNAME / _PASSWORD / H3_ACCESS_PASS
chmod 600 backend/.env

cd backend
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 18893

# Frontend (new terminal)
cd ../frontend
npm install
npm run dev   # http://localhost:4173
```

Health check: <http://127.0.0.1:18893/api/health> → `{"ok":true}`.
ComfyUI probe: <http://127.0.0.1:18893/api/comfyui/status> → GPU info.

### Video storage (decoupled)

Generated videos land in `H3_UPLOADS_DIR` (configurable in `.env`, default `./uploads`).

**Frontend reads** them via nginx `/media/` location alias. **Example nginx vhost**:

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.example;

    root /path/to/h3-studio/frontend/dist;
    index index.html;

    # History videos (read-through, no API hop)
    location /media/ {
        alias /path/to/H3_UPLOADS_DIR/;   # ← set to your actual path
        add_header Cache-Control "public, max-age=86400";
    }

    # API / WS reverse proxy
    location /api/ {
        proxy_pass http://127.0.0.1:18893;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 600s;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:18893;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

**Storage backends supported** (any directory path works):
- Local directory (default)
- S3FS mount (e.g. `H3_UPLOADS_DIR=/mnt/s3fs/h3-uploads`)
- NFS / GlusterFS / CephFS
- MinIO bucket (via rclone mount)

Requirements:
1. Backend run-user needs read permission
2. nginx worker user needs read permission
3. `/usr/local/bin/stage_h3_video.sh` needs write permission (handles sudo)

### Configuration (`backend/.env`)

| Key | Description | Example |
|---|---|---|
| `COMFYUI_BASE_URL` | ComfyUI service URL | `https://your-comfyui-host:8448` |
| `COMFYUI_USERNAME` | ComfyUI Basic Auth user | — |
| `COMFYUI_PASSWORD` | ComfyUI Basic Auth password | — |
| `H3_ACCESS_PASS` | PassGate plaintext (SHA256 hashed server-side) | — |
| `H3_UPLOADS_DIR` | Generated video directory (any path) | `/var/lib/h3-uploads` |
| `LLM_PROVIDER` | `openai` / `anthropic` / `custom` | `openai` |
| `LLM_BASE_URL` | LLM API base URL | — |
| `LLM_API_KEY` | LLM auth key | — |
| `LLM_TEXT_MODEL` | Text expansion model | `gpt-4o` |
| `LLM_VISION_MODEL` | Vision model (empty = disabled) | `gpt-4o` |
| `RTX_SSH_HOST` | (Optional) Remote GPU SSH host | — |
| `CORS_ORIGINS` | Comma-separated allowed origins | `https://your-domain.example` |

Full list: `backend/.env.example`.

### Architecture

```
Browser (your-domain.example)
    ↓
nginx 443 (TLS + reverse proxy)
    ├─ /         → h3-studio/frontend/dist      (static SPA)
    ├─ /media/   → H3_UPLOADS_DIR               (history video read-through)
    ├─ /api/     → 127.0.0.1:18893              (FastAPI)
    └─ /ws/      → 127.0.0.1:18893 Upgrade      (WebSocket GPU events)

FastAPI (18893)
    ├─ ws_bridge.py        → wss://<COMFYUI_HOST>/ws   (progress subscription)
    ├─ comfyui_client.py   → POST https://<COMFYUI_HOST>/prompt
    ├─ gpu_processes.py    → SSH nvidia-smi real GPU status
    ├─ gpu_history.py      → 5s VRAM sampling → JSONL
    ├─ submit_manager.py   → Long-task polling + stage
    └─ expand_prompt.py    → LLM prompt expansion
```

### Known issues

- **Restart delay**: systemd restart waits for `orphan_recovery`, usually 5-8s
- **Default prompt library path**: `/tmp/beatapi_repo/prompts` — override in `.env` for persistence
- **nginx `/media/` alias**: do NOT add `types{}`/`default_type`, breaks `.cover.jpg` MIME

### Patch workflow

```bash
# 1. Edit code
cd h3-studio

# 2. Backend changes
cd backend
.venv/bin/python -c "from app.main import app; print('OK')"
sudo systemctl restart h3-studio-api
journalctl -u h3-studio-api -n 20 | grep '\[BUILD\]'  # verify reload

# 3. Frontend changes
cd frontend
npm run build  # dist/ is served by nginx
```

RCA case (patch-in-disk-but-not-reload) is documented in git history.

---

## License

**Apache License 2.0** — See [`LICENSE`](./LICENSE) for the full text.

### Summary

- ✅ Free to use, modify, and distribute (with attribution)
- ✅ Commercial use allowed
- ✅ Patent grant included
- ⚠️ **Model files** (e.g. `minimax_h3_*.safetensors`, `qwen3vl_32b_minimax_h3_*.safetensors`) are **NOT** covered by this license — they are the property of MiniMax Inc. and require separate authorization to use.

### Legacy notice

This repository was previously released under a Proprietary License. As of 2026-09-18 it has been relicensed to Apache-2.0 to enable public open-source collaboration. Older commits in `git log` may reference the Proprietary terms; the current `LICENSE` file is the authoritative grant.
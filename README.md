# H3 Studio

MiniMax H3 视频生成 Web Studio — 后端 FastAPI + 前端 React/Vite，
通过 ComfyUI (RTX PRO 6000) 生成 H3 reference-to-video 内容。

> **⚠️ 部署前必读**
>
> 本仓库是通用模板。clone 后必须修改:
> 1. `backend/.env` — 填入你自己的 `COMFYUI_BASE_URL` / `COMFYUI_USERNAME` / `COMFYUI_PASSWORD` / `H3_ACCESS_PASS`
> 2. `CORS_ORIGINS` — 设为你自己的前端域名(逗号分隔,不含路径)
> 3. (可选) `LLM_*` — 任意 LLM 后端 (OpenAI / Anthropic / Ollama / 自定义),详见 README "LLM 后端" 章节
> 4. (可选) `RTX_SSH_HOST`/`RTX_SSH_USER` (GPU 状态采集)
> 5. 不要复用默认 demo 凭据,所有环境变量在 `backend/.env.example` 留空,启动前必须填齐
>
> 仓库源码中**不包含**任何生产凭据、内网 IP、demo 服务器域名 — 所有敏感值都从 `backend/.env` 读(.env 被 git 忽略)。

## 项目结构

```
h3-studio/
├── backend/                # FastAPI 后端 (Python 3.11)
│   ├── app/                # 业务代码
│   │   ├── main.py         # FastAPI 入口 + 路由
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
│   └── .env                # 真实凭据 (git-ignored,自己 cp 一份)
│
├── frontend/               # React 18 + Vite + TS + Tailwind 前端
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── components/     # PassGate, ProgressCard
│   │   ├── tabs/           # GenerateTab, HistoryTab, QueueTab
│   │   └── lib/            # api.ts, ws.ts, activeSub.ts
│   ├── vite.config.ts      # dev proxy /api & /ws → 后端 18893
│   ├── package.json
│   └── tailwind.config.js
│
└── .gitignore              # monorepo 根级遮蔽
```

## 前置条件

- **Python 3.11** (后端)
- **Node.js 18+** (前端)
- 一个可访问的 **ComfyUI 实例**，跑着 MiniMax H3 模型套件:
  - `minimax_h3_fl2va_pruned_int8_convrot.safetensors` (UNET)
  - `minimax_h3_video_vae_fp16.safetensors` (视频 VAE)
  - `minimax_h3_audio_vae_fp32.safetensors` (音频 VAE)
  - `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (CLIP)
  - `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` (Turbo LoRA)
- **反向代**: nginx 把 `/api/` 和 `/ws/` 转到 `127.0.0.1:18893`
  (生产: 见 `/etc/nginx/sites-enabled/h3.linode.fun.conf`)

## 安装与启动

### 1. 克隆并准备配置

```bash
git clone <this-repo>
cd h3-studio

# 后端: 复制 .env 模板并填真实凭据
cp backend/.env.example backend/.env
$EDITOR backend/.env   # 必填: COMFYUI_BASE_URL / _USERNAME / _PASSWORD / H3_ACCESS_PASS
chmod 600 backend/.env
```

### 2. 启动后端

```bash
cd backend
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 18893
```

健康检查：<http://127.0.0.1:18893/api/health> 应返回 `{"ok":true}`。
ComfyUI 连接检查：<http://127.0.0.1:18893/api/comfyui/status> 应返回 GPU 信息。

### 3. 启动前端 (开发模式)

另开一个终端：

```bash
cd frontend
npm install
npm run dev
# → http://localhost:4173
# Vite dev proxy 自动把 /api 和 /ws 转到 127.0.0.1:18893
```

首次访问会弹 **PassGate**——输入 `backend/.env` 里 `H3_ACCESS_PASS` 的值。

### 5. 生产构建 (前端静态站)

```bash
cd frontend
npm run build
# 产物在 frontend/dist/
```

把 Nginx  `根 ` 指向 `frontend/dist/`，并保留 `/api/`、`/ws/` 反代到后端。
示例见 `nginx-ai-gen-vhost.conf` (位于 `comfyui-webui` skill 内)。

## 配置 (backend/.env)

| Key | 说明 | 示例 |
|---|---|---|
| `COMFYUI_BASE_URL` | ComfyUI 服务地址 | `https://your-comfyui-host:8448` |
| `COMFYUI_USERNAME` | ComfyUI Basic Auth 用户名 | — |
| `COMFYUI_PASSWORD` | ComfyUI Basic Auth 密码 | — |
| `H3_ACCESS_PASS` | 前端 PassGate 口令 (明文，后端自动算 SHA256) | `***` |
| `H3_ALLOWED_SUBMITTERS` | 允许提交的 user_id 逗号分隔 | `jack` |
| `H3_RATE_LIMIT` | 每 IP 提交间隔（秒）| `300` |
| `PROMPT_LIBRARY_DIR` | prompt 库根目录（默认 `./prompts`）| `/path/to/prompts` |
| `H3_UPLOADS_DIR` | 视频上传目录 (nginx `/media/` 别名) | `/mnt/mmm/video/art/uploads` |
| `SERVICE_HOST` | 后端绑定地址 | `127.0.0.1` |
| `SERVICE_PORT` | 后端端口 | `18893` |
| `LLM_PROVIDER` | LLM 协议: `openai` / `anthropic` / `custom` | `openai` |
| `LLM_BASE_URL` | LLM API base URL | `https://api.openai.com/v1` |
| `LLM_API_KEY` | LLM 鉴权 key | `sk-...` |
| `LLM_TEXT_MODEL` | 文本扩写模型 | `gpt-4o` / `claude-3-5-sonnet-latest` |
| `LLM_VISION_MODEL` | Vision 模型 (留空 = 禁用参考图描述) | `gpt-4o` / `llava:latest` |
| `RTX_SSH_HOST` | 远端 RTX 服务器 SSH host | `gpu.example.com` |
| `RTX_SSH_USER` | RTX SSH 用户名 | `gpu` |
| `RTX_SSH_PASS` | RTX SSH 密码 (推荐改用 key) | — |
| `RTX_SSH_KEY` | RTX SSH 私钥路径 | `/home/user/.ssh/id_ed25519` |
| `CORS_ORIGINS` | 逗号分隔的允许跨域源 (留空 = 仅 localhost) | `https://your-domain.example,http://localhost:3000` |

## LLM 后端 (通用)

`expand_prompt.py` 已重构为通用 LLM 客户端 (`backend/app/llm_client.py`),
**支持任意 OpenAI 兼容协议 / Anthropic native / 自定义 endpoint**。

### 协议选择

| Provider | 鉴权 | 默认 Endpoint | 适用 |
|---|---|---|---|
| `openai` | `Authorization: Bearer` | `/chat/completions` | OpenAI / DeepSeek / Ollama / vLLM / 一加 |
| `anthropic` | `x-api-key` | `/v1/messages` | Claude 3.5/4 系列 |
| `custom` | `Authorization: Bearer` | 自定义 | 私有部署 |

### 配置示例

```bash
# OpenAI
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_TEXT_MODEL=gpt-4o
LLM_VISION_MODEL=gpt-4o

# Anthropic
LLM_PROVIDER=anthropic
LLM_BASE_URL=https://api.anthropic.com
LLM_API_KEY=sk-ant-...
LLM_TEXT_MODEL=claude-3-5-sonnet-latest
LLM_VISION_MODEL=claude-3-5-sonnet-latest

# 一加 (原 MiniMax-M3,OpenAI 协议兼容)
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.minimaxi.com/v1
LLM_API_KEY=...
LLM_TEXT_MODEL=MiniMax-M3
LLM_VISION_MODEL=MiniMax-Text-01

# 本地 Ollama
LLM_PROVIDER=openai
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_API_KEY=ollama          # Ollama 任意非空字符串
LLM_TEXT_MODEL=qwen2.5:32b
LLM_VISION_MODEL=llava:latest
```

### 向后兼容

旧 `MINIMAX_CN_API_KEY` / `MINIMAX_CN_BASE_URL` 仍然识别 —
没有显式 `LLM_*` 配置时,llm_client 会从这些变量和 `~/.hermes/.env` 兜底读。
推荐:clone 后改为 `LLM_*` 命名。

### 降级行为

- `LLM_API_KEY` 空 → `chat_text` 抛 `RuntimeError`,前端拿到 500 + 明确错误信息
- `LLM_TEXT_MODEL` 空 → 同上
- `LLM_VISION_MODEL` 空 → vision 禁用,前端自动降级为 T2VA(无参考图)

### 高级:自定义 endpoint

如果你的 LLM 用非常规路径(如 minimax 的 `text/chatcompletion_v2` 而非 `chat/completions`),
可设:

```bash
LLM_VISION_ENDPOINT=text/chatcompletion_v2
LLM_TEXT_ENDPOINT=chat/completions
```

## systemd 部署

`/etc/systemd/system/h3-studio-api.service` 模板：

```ini
[Unit]
Description=H3 Studio API (FastAPI) - serves h3.linode.fun /api and /ws
After=network.target

[Service]
Type=simple
User=hermes
Group=hermes
WorkingDirectory=/srv/h3-studio/backend
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="PYTHONUNBUFFERED=1"
# Secrets are loaded from backend/.env by app/config.py at startup.
ExecStart=/srv/h3-studio/backend/.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 18893 --log-level info
Restart=on-failure
RestartSec=3s

[Install]
WantedBy=multi-user.target
```

注意：**不要在 unit 里写 `Environment=COMFYUI_PASSWORD=***` 之类敏感值**——全部走 `.env`。

## 架构

```
浏览器 (h3.linode.fun)
    ↓
nginx 443 (TLS + 反代)
    ├─ /         → /srv/h3-studio/frontend/dist  (静态站)
    ├─ /media/   → /mnt/mmm/video/art/uploads    (历史视频直读)
    ├─ /api/     → 127.0.0.1:18893               (FastAPI)
    └─ /ws/      → 127.0.0.1:18893 (Upgrade)     (WebSocket)

FastAPI (18893)
    ├─ ws_bridge.py ──→ wss://<COMFYUI_HOST>/ws  (ComfyUI 进度)
    ├─ comfyui_client.py ──→ POST https://<COMFYUI_HOST>/prompt
    ├─ gpu_history.py (每 30s 采样 VRAM,写 /tmp/h3-gpu-history.jsonl)
    └─ prompt_library.py / expand_prompt.py (本地 prompt 库 + LLM 扩写)

h3-video.linode.fun (子域,独立后端 :18891)
    └─ 展示 /mnt/mmm/video/art/uploads 全部历史视频
```

## 已知坑

- **重启卡住**: systemd restart 时 `uvicorn` 等 `orphan_recovery` 完成, 通常 5-8 秒
- **GPU VRAM 监控 ws 5  GPU 频繁 (<5s)**: GPU history 走文件 io, 远端 ComfyUI 上偶发 stall
- **prompt 库默认指向 `/tmp/beatapi_repo/prompts`**: 容器清空后会丢, 生产请在 `.env` 覆盖为持久目录
- **nginx `/media/` 别名不要加 `types{}` default_type**: 会把 `.cover.jpg` 缩略图强制成 `video/mp4`, 飞书/聊天工具读不了
- **前端 `base: './'`**: 用相对路径而非绝对 `/`, 方便部署到任意子路径

## 配套 skill

`~/.hermes/skills/devops/comfyui-webui/` 里有完整的 ComfyUI 操作流程:
- `inventory-comfyui-instance.sh` — 探活
- `probe-submit-api.py` — 提交 workflow 测试
- `melody_to_ref_audio.py` — 音频参考提取
- `reference-image-upload.md` — 真正上传用户参考图 (vs 当前的 Logo.jpg 偷懒做法)
- `comfyui-polling-fallback.md` — 长任务 polling 兜底

## License

**Proprietary — All Rights Reserved.** See [`LICENSE`](./LICENSE) for full terms.

仓库**不是**开源项目:
- 源码允许个人/内部团队 clone、修改、部署
- **禁止**公开 fork、对外分发、再授权
- 商业用途需作者书面授权
- 仓库内代码引用了 MiniMax 私有模型文件结构 (H3 model names) — 第三方独立运行需要从 MiniMax 获取模型访问权限
- 实际授权边界以 `LICENSE` 文件为准,README 此处仅为概要
# H3 Studio — Commit Strategy & Push Script

本仓库设计为 **monorepo**(单仓库装前后端),按 Conventional Commits + Gitmoji 双风格混合 commit。

---

## 推荐初始 commit 拆分(避免 one-shot 巨型 commit)

```
chore: initial repo structure (gitignore + LICENSE + .env.example)
feat(backend): add generic LLM client (OpenAI/Anthropic/custom compatible)
feat(backend): add H3 prompt expansion (Ref2VA/T2VA structured output)
feat(backend): add ComfyUI submission manager + GPU process inspector
feat(backend): add FastAPI app (auth, history, GPU events WS bridge)
feat(frontend): add React/Vite/TS frontend (PassGate, Generate/History/Queue tabs)
fix(security): remove hardcoded credentials and demo hostnames
docs: comprehensive README + LLM provider examples
```

---

## 推送步骤(在你 review commit 后)

```bash
cd /srv/h3-studio

# 1. 初始化(如果未做)
git init
git config user.name "Your Name"
git config user.email "your@email.com"
git branch -M main  # 或 master

# 2. 首次提交(按上面拆分逐个 commit)
git add .gitignore LICENSE README.md backend/.gitignore backend/.env.example frontend/.env.example
git commit -m "chore: initial repo structure (gitignore + LICENSE + .env.example)"

git add backend/systemd/ backend/tests/ backend/requirements.txt backend/app/__init__.py
git commit -m "feat(backend): scaffold Python package + systemd unit template"

git add backend/app/llm_client.py
git commit -m "feat(backend): add generic LLM client

Supports OpenAI-compatible protocol, Anthropic native, and custom endpoints.
Backward-compatible with legacy MINIMAX_CN_* env vars for Hermes Agent deployments.

Features:
- chat_text() with 3 call styles (string / positional list / keyword messages)
- chat_vision() for reference image description
- thinking-block stripping (M3 / Claude / o1)
- config caching with reset_config_cache() for tests"

git add backend/app/expand_prompt.py
git commit -m "feat(backend): add H3 prompt expansion (Ref2VA/T2VA)

Converts simple user prompts into structured H3 prompts:
- Ref2VA mode: 6 sections (subject_definitions, summary, retention_analysis,
  detailed_description, overall_soundscape, non_diegetic_music)
- T2VA mode: 3 sections (integrated_multimodal_description, soundscape, music)
- Vision description via LLM vision API (optional)
- Auto-truncation at [Shot N] boundaries if prompt exceeds max_chars"

git add backend/app/comfyui_client.py backend/app/submit_manager.py backend/app/workflow_builder.py backend/app/orphan_recovery.py
git commit -m "feat(backend): add ComfyUI submission pipeline

- comfyui_client: HTTP API wrapper (Basic Auth, JSON)
- submit_manager: submission lifecycle (queue → poll → stage video)
- workflow_builder: H3 workflow JSON construction
- orphan_recovery: recover from abandoned submissions after restart
- sibling viewer refresh on video stage"

git add backend/app/config.py backend/app/ws_bridge.py backend/app/history_scanner.py backend/app/prompt_library.py backend/app/gpu_history.py backend/app/gpu_processes.py backend/app/main.py
git commit -m "feat(backend): add FastAPI app + GPU inspector

- config: env-driven settings with CORS/RTX_SSH/COMFYUI_* knobs
- ws_bridge: subscribe remote ComfyUI WS, forward events to /ws/gpu-events
- history_scanner: scan uploads dir for finished videos
- prompt_library: load prompt templates from PROMPT_LIBRARY_DIR
- gpu_history: 30s VRAM sampling to JSONL
- gpu_processes: SSH-based nvidia-smi + vLLM model introspection
- main: FastAPI app with 26 routes (auth, health, generate, history, gpu events)"

git add frontend/.gitignore 2>/dev/null || true
git add frontend/index.html frontend/package.json frontend/package-lock.json frontend/tsconfig.json frontend/tailwind.config.js frontend/postcss.config.js frontend/vite.config.ts frontend/public/
git commit -m "feat(frontend): scaffold Vite + React 18 + TypeScript + Tailwind"

git add frontend/src/
git commit -m "feat(frontend): add PassGate + Generate/History/Queue tabs

- PassGate: SHA256 password gate against H3_ACCESS_PASS_HASH
- GenerateTab: prompt input + ref image upload + submit
- HistoryTab: video grid (mobile-first) with optional gallery link
- QueueTab: live GPU event stream (WS) + history sparkline
- api.ts: fetch wrapper (same-origin /api/*)
- ws.ts: WebSocket reconnect with exponential backoff"

# 3. 最后一次安全扫描
git log --oneline
echo "--- 39 files in, ready to push ---"

# 4. 推 GitHub (要先 gh auth login 或配 SSH key)
# 选项 A: GitHub CLI
gh repo create h3-studio --private --source=. --remote=origin --push
# 选项 B: 手动
# git remote add origin git@github.com:YOUR_USER/h3-studio.git
# git push -u origin main
```

---

## 仓库结构(最终)

```
/srv/h3-studio/                39 files tracked
├── LICENSE                    ← R1 修复 (proprietary)
├── README.md                  ← R7 修复 (移除 "联系作者", 指向 LICENSE)
├── .gitignore                 ← R4 修复 (加 frontend/.env*)
├── backend/
│   ├── .env.example           ← CORS_ORIGINS 章节 + LLM 模板
│   ├── .gitignore
│   ├── requirements.txt
│   ├── systemd/
│   │   ├── .gitkeep
│   │   └── h3-studio-api.service.template
│   ├── tests/
│   │   └── .gitkeep
│   └── app/                   ← 14 .py 文件, 全部脱敏, CORS env-driven
└── frontend/
    ├── .env.example           ← VITE_GALLERY_URL 文档
    ├── index.html
    ├── package.json
    ├── package-lock.json
    ├── postcss.config.js
    ├── public/akamai-logo.png
    ├── src/                   ← 12 .ts/.tsx 文件, 无硬编码生产域名
    ├── tailwind.config.js
    ├── tsconfig.json
    └── vite.config.ts
```

---

## 推送前最后一次自检 checklist

```bash
# A. 无 .env 入仓
git ls-files | grep -E "\.env$" && echo "❌ LEAK" || echo "✅ no .env tracked"

# B. 无内网 IP 泄漏 (除 localhost 127.0.0.1)
git ls-files | xargs grep -lE "172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+" 2>/dev/null && echo "❌ LEAK" || echo "✅ no internal IPs"

# C. 无生产域名 (h3.linode.fun / h3.linapp.fun) 在源码里
git ls-files | xargs grep -lE "h3\.linode\.fun|h3\.linapp\.fun" 2>/dev/null && echo "⚠️  only in docs/nginx examples" || echo "✅ clean"

# D. LICENSE 文件入仓
git ls-files | grep -E "^LICENSE$" && echo "✅ LICENSE tracked"

# E. 没有遗留 .bak / dist / node_modules
git ls-files | grep -E "(\.bak|node_modules|dist/|__pycache__|\.venv)" && echo "❌ LEAK" || echo "✅ no build artifacts"

# F. requirements.txt 是锁版本的
cat backend/requirements.txt | grep -E "^[a-z]" | grep -v "==" && echo "❌ un-pinned" || echo "✅ all pinned"
```
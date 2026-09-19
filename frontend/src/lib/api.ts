// API 客户端 - 同一个 origin 时不用写 host (通过 nginx 反代)
// 同源部署时,fetch('/api/...') 自动走当前域名

export interface QueueTask {
  queue_index: number
  prompt_id: string
  executing_node: string | null
  node_label: string
  preview_prompt: string
  // 2026-09-06: ETA 字段
  length: number | null           // 帧数 (从节点 10 取)
  duration_s: number              // 原始视频秒数 (length / 24)
  estimated_total_sec: number     // 后端算的总耗时估算
  running_started_at?: number     // 进入 ComfyUI running 的时刻 (epoch 秒, 仅后端 submit_manager 认识的 prompt 才有)
  elapsed_sec?: number            // 当前已跑秒数 (running 时才有)
  is_self: boolean                // 是否本 UI 自己提交的
  submission_id: string           // 对应后端 submission_id (is_self 时有值)
}

export interface QueueSnapshot {
  ok?: boolean                  // 后端在 /api/queue 响应里塞的可用性标志 (2026-09-15 加)
  unavailable?: boolean
  error?: string
  running_count: number
  pending_count: number
  running: QueueTask[]
  pending: QueueTask[]
  // 2026-09-06: ETA 总字段
  sec_per_frame: number           // 实时校准的 sec/frame (来自 history 最近 10 条均值)
  calibration_samples: number     // 用了多少条 history 校准
  eta_total_sec: number           // 1) 所有任务: Σpending + running[0] 剩余
  eta_running_sec: number         // 2) 当前任务: 仅 running[0] 剩余 (没人在跑=0)
  eta_self_sec: number | null     // 3) 我自己提交的最早未完成任务的 ETA
  eta_self_position: string | null // 例如 "队列第 3 位"
  ts: number
}

export interface PromptItem {
  slug: string
  title: string
  category: string
  duration: string
}

export interface PromptDetail extends PromptItem {
  prompt: string
  mode: string
  aspect: string
}

export interface CategoryStat {
  name: string
  count: number
}

export interface Submission {
  submission_id: string
  prompt_text: string
  duration_s: number
  seed: number
  client_id: string
  submitter: string
  submitted_at: number
  prompt_id: string | null
  status: 'pending' | 'submitted' | 'running' | 'done' | 'error'
  progress: number
  progress_step: number
  progress_max: number
  error: string | null
  finished_at: number | null
  output_files: any[]
}

export interface HistoryItem {
  slug: string
  title: string
  filename: string
  size: number
  mtime: number
  upload_date: string
  web_path: string
  meta: {
    ref_image?: string
    [k: string]: any
  }
}

const BASE = ''  // 同源

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path)
  if (!r.ok) throw new Error(`${path} → ${r.status}`)
  return r.json()
}

async function jpost<T>(path: string, body: any, userId = 'jack', isForm = false): Promise<T> {
  const headers: Record<string, string> = {
    'X-User-Id': userId,
  }
  if (!isForm) headers['Content-Type'] = 'application/json'
  if (path === '/api/submit' || path === '/api/upload-ref' || path === '/api/expand-prompt' || path === '/api/history/delete') {
    const hash = localStorage.getItem('h3_pass_hash')
    if (hash) headers['X-H3-Pass'] = hash
  }
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers,
    body: isForm ? body : JSON.stringify(body),
  })
  if (!r.ok) {
    const txt = await r.text()
    throw new Error(`${path} → ${r.status}: ${txt}`)
  }
  return r.json()
}

export const api = {
  health: () => jget<{ ok: boolean }>('/api/health'),

  // ComfyUI
  comfyStatus: () => jget<any>('/api/comfyui/status'),
  queue: () => jget<QueueSnapshot>('/api/queue'),

  // Prompt 库
  prompts: (q = '', category = 'all', limit = 50) =>
    jget<{ q: string; category: string; total: number; results: PromptItem[] }>(
      `/api/prompts?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&limit=${limit}`
    ),
  promptCategories: () => jget<{ categories: CategoryStat[] }>('/api/prompts/categories'),
  promptDetail: (slug: string) => jget<PromptDetail>(`/api/prompts/${slug}`),

  // 提交
  submit: (body: { prompt_text: string; duration_s?: number; seed?: number; resolution?: '480p' | '720p' | '1080p'; ref_image?: string | null }, userId = 'jack') =>
    jpost<Submission>('/api/submit', body, userId),
  submissions: (limit = 20) => jget<{ submissions: Submission[] }>(`/api/submissions?limit=${limit}`),
  submission: (id: string) => jget<Submission>(`/api/submissions/${id}`),

  // 上传参考图 (multipart), 返回 { ref_image, size_bytes }
  // 服务端会强制转 JPEG, 短边自动压到 ≤2048
  uploadRef: (file: File) => {
    const form = new FormData()
    form.append('image', file)
    return jpost<{ ref_image: string; size_bytes: number }>('/api/upload-ref', form as any, 'jack', true)
  },

  // H3 Prompt 扩写 (multipart: prompt + duration_s + 可选 ref_image)
  // mode = T2VA (无 ref) 或 Ref2VA (有 ref)
  // 预估 8-15 秒, 期间 UI 显示 loading
  expandPrompt: (
    prompt: string,
    duration_s: number,
    refImageFile?: File | null,
  ) => {
    const form = new FormData()
    form.append('prompt', prompt)
    form.append('duration_s', String(duration_s))
    if (refImageFile) form.append('ref_image', refImageFile)
    return jpost<{
      prompt: string
      structured: Record<string, string>
      mode: 'T2VA' | 'Ref2VA'
      duration_s: number
      image_description: string | null
      vision_error: string | null
      prompt_length: number
      warning: string | null
    }>('/api/expand-prompt', form as any, 'jack', true)
  },

  // 历史
  history: (limit = 50, date?: string) =>
    jget<{ count: number; items: HistoryItem[] }>(
      `/api/history?limit=${limit}${date ? `&date=${date}` : ''}`
    ),
  historyDates: () => jget<{ dates: string[] }>('/api/history/dates'),

  // 当前 GPU 上加载的模型清单 + 各自 VRAM
  modelsLoaded: () =>
    jget<{
      vram_total_gb: number
      vram_used_gb: number
      static_models_total_gb: number
      runtime_overhead_gb: number
      models: Array<{
        filename: string
        category: string
        category_folder: string
        icon: string
        size_bytes: number | null
        size_bytes_est?: number
        size_gb?: number
        size_gb_est?: number
        is_estimate: boolean
        is_h3_default: boolean
      }>
      fetched_at: number
    }>('/api/models/loaded'),

  // 真实 GPU 状态 (nvidia-smi via SSH, 含 vLLM 等所有进程)
  gpuProcesses: () =>
    jget<{
      gpu: null | {
        name: string
        memory_total_gb: number
        memory_used_gb: number
        memory_free_gb: number
        utilization_gpu_pct: number
        temperature_c: number
        power_watts: number
      }
      processes: Array<{
        pid: number
        process_name: string
        used_memory_gb: number
      }>
      vllm_models: Array<{
        id: string
        root: string
        max_model_len?: number
        owned_by?: string
      }>
      comfyui_models_on_disk: Record<string, string[]>
      comfyui_currently_loaded: null | {
        filenames: string[]
        sizes_bytes: Record<string, number>
        prompt_id: string
        timestamp_ms: number
        age_seconds: number | null
      }
      fetched_at: number
      stale: boolean
      last_error: string | null
    }>('/api/gpu/processes'),

  gpuProcessesRefresh: () => jpost<any>('/api/gpu/processes/refresh', {}, 'jack'),

  // 软删除 (隐藏) 视频 — 2026-09-06: 文件保留, 仅前端不可见
  // upload_date 帮后端快速定位 .meta.json 路径, 避免扫全目录
  hideVideo: (filename: string, upload_date?: string, userId = 'jack') =>
    jpost<{ ok: boolean; filename: string; hidden: boolean; hidden_at: string; note: string }>(
      '/api/history/delete',
      { filename, upload_date },
      userId,
    ),

  // 兼容旧名 (有些调用方可能还在用 deleteVideo)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deleteVideo: (filename: string, upload_date?: string, userId = 'jack') =>
    jpost<{ ok: boolean; filename: string; hidden: boolean; hidden_at: string; note: string }>(
      '/api/history/delete',
      { filename, upload_date },
      userId,
    ),
}

// 媒体 URL helper - 走当前域名, /media 由 nginx 反代到 H3_UPLOADS_DIR
export const mediaUrl = (webPath: string) => webPath

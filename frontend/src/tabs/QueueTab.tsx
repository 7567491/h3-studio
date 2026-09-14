import { useState, useEffect, useCallback, useMemo } from 'react'
import { api, type QueueSnapshot } from '../lib/api'
import { useActiveSub } from '../lib/activeSub'
import ProgressCard from '../components/ProgressCard'

interface GpuStatus {
  ok: boolean
  gpu_name?: string
  vram_total_gb?: number
  vram_used_gb?: number
  vram_free_gb?: number
  vram_used_pct?: number
}

interface GpuSample {
  t: number
  used_gb: number
  total_gb: number
}

interface GpuHistoryResp {
  interval_s: number
  max_samples: number
  current_count: number
  samples: GpuSample[]
}

export default function QueueTab() {
  const [q, setQ] = useState<QueueSnapshot | null>(null)
  const [status, setStatus] = useState<GpuStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // 跨 Tab 共享的活跃 submission — GenerateTab 提交后这里也立即显示
  const { sub: activeSub, promptText: activePromptText, setActiveSub } = useActiveSub()

  const refresh = useCallback(async () => {
    try {
      const [qd, sd] = await Promise.all([api.queue(), api.comfyStatus()])
      setQ(qd)
      setStatus(sd)
      setErr(null)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  // === WebSocket 实时事件订阅 ===
  // 后端 /ws/gpu-events 桥接 远端 ComfyUI WS, 转发 executing/progress 事件
  // 当前 QueueTab 只用 executing (Running task row 高亮 "节点 X 执行中"),
  // progress 由用户自己提交的 ProgressCard (跨 Tab 共享) 处理
  // WS 断了也不影响轮询 (5s 兜底)
  const [wsExecuting, setWsExecuting] = useState<{ node: string; prompt_id: string } | null>(null)

  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimer: number | null = null
    let alive = true

    const connect = () => {
      if (!alive) return
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${proto}//${location.host}/ws/gpu-events`)

      ws.onopen = () => {
        console.log('[GPU WS] connected')
      }
      ws.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data)
          if (evt.type === 'executing') {
            setWsExecuting({
              node: evt.node,
              prompt_id: evt.prompt_id,
            })
          } else if (evt.type === 'execution_success' || evt.type === 'execution_error') {
            setWsExecuting(null)
          } else if (evt.type === 'snapshot') {
            if (evt.executing) setWsExecuting(evt.executing)
          }
        } catch {}
      }
      ws.onclose = () => {
        if (!alive) return
        console.log('[GPU WS] closed, reconnect in 3s')
        reconnectTimer = window.setTimeout(connect, 3000)
      }
      ws.onerror = () => {
        ws?.close()
      }
    }
    connect()

    return () => {
      alive = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // === ETA 显示 (Jack 2026-09-06) ===
  // 后端 /api/queue 已经算好三个 ETA:
  //   q.eta_total_sec    = Σ(pending.est_total) + max(0, running[0].est_total - elapsed)  ← 所有任务
  //   q.eta_running_sec  = max(0, running[0].est_total - elapsed)                        ← 当前任务
  //   q.eta_self_sec     = 我自己提交的最早未完成任务的 ETA (可能为 null)                ← 我的任务
  // 这里 5 秒刷新一次 (setInterval 5000),每次 render 直接读后端预算好的值
  const etaTotalSec    = q?.eta_total_sec    ?? 0
  const etaRunningSec  = q?.eta_running_sec  ?? 0
  const etaSelfSec     = q?.eta_self_sec     ?? null
  const etaSelfPos     = q?.eta_self_position ?? null
  // pending Σ: 排队总剩余时间 (前端直接算,从 q.pending 数组 sum)
  const pendingTotalSec = useMemo(
    () => (q?.pending ?? []).reduce((s, t) => s + (t.estimated_total_sec || 0), 0),
    [q?.pending],
  )

  // 把秒数格式化成 "X m X s" (Jack 偏好); 0 显示 "0 m 0 s"
  const formatETA = (s: number): string => {
    if (s <= 0) return '0 m 0 s'
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m} m ${sec} s`
  }

  return (
    <div className="space-y-4 animate-slide-up">
      <div>
        <h2 className="text-2xl font-bold">GPU 状态</h2>
        <p className="text-sm text-gray-400 mt-1">ComfyUI 实时队列 · 5秒刷新</p>
        <p className="text-xs text-gray-600 mt-0.5">GPU Status · Live queue, refreshes every 5s</p>
      </div>

      {err && (
        <div className="bg-err/10 border border-err/30 rounded-2xl p-4 text-err text-sm">
          ⚠ ComfyUI 不可用: {err}
        </div>
      )}

      {loading && !q && (
        <div className="text-center text-gray-500 py-12">加载中…</div>
      )}

      {q && (
        <>
          {/* GPU 真实状态 (nvidia-smi via SSH, 含 vLLM 等所有进程) */}
          <GpuRealStatus />

          {/* GPU 显存 1h 历史曲线 (GpuRealStatus L155 已显示实时 82.1/95.59 GB) */}
          {status?.ok && status?.vram_total_gb != null && (
            <GpuHistoryChart
              totalGb={status.vram_total_gb}
              key={`hist-${status.vram_total_gb}`}
            />
          )}

          {/* 队列 Dashboard: 2 列 + 可选第 3 列 (我的任务)
              - 正在生成 N + 当前任务剩余时间
              - 排队等待 N + Σpending 剩余时间
              - 我的任务: 自己提交的最早未完成 (无则整列隐藏) */}
          {(q.running_count > 0 || q.pending_count > 0) && (
            <div className="bg-bg-card rounded-2xl p-4 space-y-2">
              <div
                className={`grid gap-3 ${
                  etaSelfSec !== null ? 'grid-cols-3' : 'grid-cols-2'
                }`}
              >
                {/* 1) 正在生成 + 当前任务剩余 */}
                <div className="bg-bg-hover rounded-xl p-3">
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider">
                    正在生成 · Generating
                  </div>
                  <div className="text-2xl font-bold text-warn mt-1 tabular-nums">
                    {q.running_count}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-1 tabular-nums">
                    剩余 {q.running_count > 0 ? `~${formatETA(etaRunningSec)}` : '—'}
                  </div>
                </div>

                {/* 2) 排队等待 + Σpending 剩余 */}
                <div className="bg-bg-hover rounded-xl p-3">
                  <div className="text-[10px] text-gray-400 uppercase tracking-wider">
                    排队等待 · Queued
                  </div>
                  <div className="text-2xl font-bold text-accent mt-1 tabular-nums">
                    {q.pending_count}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-1 tabular-nums">
                    剩余 ~{formatETA(pendingTotalSec)}
                  </div>
                </div>

                {/* 3) 我的任务 (无则整列隐藏) */}
                {etaSelfSec !== null && (
                  <div className="bg-bg-hover rounded-xl p-3">
                    <div className="text-[10px] text-accent uppercase tracking-wider">
                      我的任务 · My ETA
                    </div>
                    <div className="text-xl font-bold text-accent mt-1 tabular-nums">
                      ~{formatETA(etaSelfSec)}
                    </div>
                    {etaSelfPos && (
                      <div className="text-[10px] text-gray-500 mt-0.5">
                        {etaSelfPos}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 当前任务进度小字(只在有 elapsed 时显示) */}
              {q.running_count > 0 &&
                q.running[0]?.elapsed_sec !== undefined &&
                q.running[0].elapsed_sec > 0 && (
                  <div className="text-[10px] text-gray-600 text-center">
                    当前已跑 {q.running[0].elapsed_sec.toFixed(0)}s / 估算 {q.running[0].estimated_total_sec}s
                  </div>
                )}

              {/* 校准元信息(放最后,小字) */}
              <div className="text-[10px] text-gray-600 text-center pt-1 border-t border-white/5">
                校准 {q.calibration_samples ?? 0} 条历史 · {q.sec_per_frame?.toFixed(2) ?? '—'} s/帧
              </div>
            </div>
          )}

          {/* 正在运行 */}
          {q.running.length > 0 && (
            <Section title="⚡ Running">
              {q.running.map((t, i) => (
                <RunningTaskRow key={t.prompt_id ?? i} task={t} />
              ))}
            </Section>
          )}

          {/* 等待中 */}
          {q.pending.length > 0 && (
            <Section title="⏳ Pending">
              {q.pending.map((t, i) => (
                <TaskRow key={t.prompt_id ?? i} task={t} kind="pending" queueIdx={i + 1} />
              ))}
            </Section>
          )}

          {q.running_count === 0 && q.pending_count === 0 && (
            <div className="text-center text-gray-500 py-12">
              <div className="text-4xl mb-2">✨</div>
              <div className="text-sm">队列空闲,可以提交新任务</div>
            </div>
          )}
        </>
      )}

      {/* === 当前活跃任务进度卡 (跨 Tab 共享, GenerateTab 提交后这里也显示) === */}
      {activeSub && (
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-2 text-sm text-gray-400">
            <span>📺 当前任务</span>
            <span className="text-[10px] text-gray-600">Active submission · 跨 Tab 共享</span>
          </div>
          <ProgressCard
            sub={activeSub}
            promptText={activePromptText}
            onReset={() => setActiveSub(null)}
          />
        </div>
      )}
    </div>
  )
}

function StatCard({ label, en, value, accent }: { label: string; en?: string; value: number; accent: string }) {
  return (
    <div className="bg-bg-card rounded-2xl p-4">
      <div className="text-xs text-gray-400">{label}</div>
      {en && <div className="text-[10px] text-gray-600 leading-tight">{en}</div>}
      <div className={`text-3xl font-bold mt-1 ${accent}`}>{value}</div>
    </div>
  )
}

// ========================================== GPU 上加载的模型 + 各自 VRAM
// 调 /api/models/loaded, 每 10s 刷新一次 (静态文件大小不会变, 但 runtime_overhead 会变)
type LoadedModel = {
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
}
type ModelsLoadedResp = {
  vram_total_gb: number
  vram_used_gb: number
  static_models_total_gb: number
  runtime_overhead_gb: number
  models: LoadedModel[]
  fetched_at: number
}

function GpuRealStatus() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.gpuProcesses>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const d = await api.gpuProcesses()
      setData(d)
      setErr(d.last_error ?? null)
    } catch (e: any) {
      setErr(e.message ?? 'fetch failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)  // 5s 刷新 (用户要求)
    return () => clearInterval(t)
  }, [refresh])

  // 估算 vLLM 占用 (用 models id + root 找进程名 VLLM)
  const vllmProcess = data?.processes.find(p => p.process_name.includes('VLLM'))
  const comfyuiProcess = data?.processes.find(p => p.process_name.includes('ComfyUI') || p.process_name.includes('comfyui_native'))
  const otherProcesses = data?.processes.filter(p =>
    !p.process_name.includes('VLLM') && !p.process_name.includes('ComfyUI') && !p.process_name.includes('comfyui_native')
  )

  return (
    <div className="bg-bg-card rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-gray-300">🖥️ GPU 真实状态</div>
          <div className="text-[10px] text-gray-600">nvidia-smi (via SSH) · 5秒刷新</div>
        </div>
        {data?.gpu && (
          <div className="text-right">
            <div className="text-[10px] text-gray-500">整卡 VRAM</div>
            <div className="text-sm font-mono text-accent">
              {data.gpu.memory_used_gb.toFixed(1)} / {data.gpu.memory_total_gb.toFixed(1)} GB
              <span className="text-gray-500 ml-1">
                ({((data.gpu.memory_used_gb / data.gpu.memory_total_gb) * 100).toFixed(0)}%)
              </span>
            </div>
          </div>
        )}
      </div>

      {loading && !data && (
        <div className="text-xs text-gray-500 py-2">加载中…</div>
      )}

      {err && (
        <div className="text-xs text-warn bg-warn/10 border border-warn/30 rounded p-2">
          ⚠ {err} {data?.stale && '(显示缓存)'}
        </div>
      )}

      {data?.gpu && (
        <>
          {/* 整卡 stats */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="bg-bg rounded p-2">
              <div className="text-gray-500 text-[10px]">GPU 型号</div>
              <div className="text-gray-300 truncate" title={data.gpu.name}>
                {data.gpu.name.replace('NVIDIA ', '')}
              </div>
            </div>
            <div className="bg-bg rounded p-2">
              <div className="text-gray-500 text-[10px]">利用 / 温 / 功耗</div>
              <div className="font-mono text-gray-300">
                {data.gpu.utilization_gpu_pct}% / {data.gpu.temperature_c}°C / {data.gpu.power_watts.toFixed(0)}W
              </div>
            </div>
          </div>

          {/* 进程级 VRAM 占用 */}
          <div className="space-y-1.5">
            <div className="text-[10px] text-gray-500 uppercase tracking-wide">
              进程级占用 ({data.processes.length} 个)
            </div>

            {vllmProcess && (
              <div className="space-y-0.5">
                <div className="flex items-center justify-between text-xs gap-2">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="text-sm flex-shrink-0">🦙</span>
                    <span className="truncate font-medium text-err" title={vllmProcess.process_name}>
                      VLLM::{data.vllm_models[0]?.id ?? 'EngineCore'}
                    </span>
                    <span className="text-[9px] text-err bg-err/10 px-1 rounded flex-shrink-0">
                      非 ComfyUI
                    </span>
                  </div>
                  <div className="font-mono text-err flex-shrink-0">
                    {vllmProcess.used_memory_gb.toFixed(2)} GB
                    <span className="text-gray-500 ml-1">
                      ({((vllmProcess.used_memory_gb / data.gpu.memory_total_gb) * 100).toFixed(1)}%)
                    </span>
                  </div>
                </div>
                {data.vllm_models[0] && (
                  <div className="text-[10px] text-gray-500 pl-7 truncate" title={data.vllm_models[0].root}>
                    {data.vllm_models[0].id} → {data.vllm_models[0].root}
                  </div>
                )}
                <div className="h-1.5 bg-bg rounded-full overflow-hidden">
                  <div
                    className="h-full bg-err transition-all"
                    style={{ width: `${Math.min(100, (vllmProcess.used_memory_gb / data.gpu.memory_total_gb) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {comfyuiProcess && (
              <div className="space-y-0.5">
                <div className="flex items-center justify-between text-xs gap-2">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="text-sm flex-shrink-0">🎬</span>
                    <span className="truncate font-medium text-accent" title={comfyuiProcess.process_name}>
                      ComfyUI
                    </span>
                    <span className="text-[9px] text-gray-500 bg-bg px-1 rounded flex-shrink-0">
                      PID {comfyuiProcess.pid}
                    </span>
                  </div>
                  <div className="font-mono text-gray-300 flex-shrink-0">
                    {comfyuiProcess.used_memory_gb.toFixed(2)} GB
                    <span className="text-gray-500 ml-1">
                      ({((comfyuiProcess.used_memory_gb / data.gpu.memory_total_gb) * 100).toFixed(1)}%)
                    </span>
                  </div>
                </div>
                <div className="h-1.5 bg-bg rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{ width: `${Math.min(100, (comfyuiProcess.used_memory_gb / data.gpu.memory_total_gb) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {(otherProcesses ?? []).map((p) => (
              <div key={p.pid} className="flex items-center justify-between text-xs gap-2 px-2">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <span className="text-sm flex-shrink-0">⚙️</span>
                  <span className="truncate text-gray-400" title={p.process_name}>{p.process_name}</span>
                </div>
                <div className="font-mono text-gray-400 flex-shrink-0">
                  {p.used_memory_gb.toFixed(2)} GB
                </div>
              </div>
            ))}
          </div>

          {/* ComfyUI 加载的模型 (实时从 /history 反推 Loader 节点) */}
          {data?.comfyui_models_on_disk && (
            <ComfyuiModelsBlock
              onDisk={{
                checkpoints: data.comfyui_models_on_disk.checkpoints ?? [],
                diffusion_models: data.comfyui_models_on_disk.diffusion_models ?? [],
                vae: data.comfyui_models_on_disk.vae ?? [],
                loras: data.comfyui_models_on_disk.loras ?? [],
                text_encoders: data.comfyui_models_on_disk.text_encoders ?? [],
              }}
              currentlyLoaded={data.comfyui_currently_loaded ?? null}
              comfyProcess={comfyuiProcess}
              totalGb={data.gpu.memory_total_gb}
            />
          )}

          {/* 底部 — 刷新时间 */}
          <div className="pt-2 mt-1 border-t border-white/5 text-[10px] text-gray-500 flex flex-wrap gap-x-3 gap-y-1">
            <span>已用: <span className="text-accent font-mono">{data.gpu.memory_used_gb.toFixed(1)} GB</span></span>
            <span>空闲: <span className="text-gray-300 font-mono">{data.gpu.memory_free_gb.toFixed(1)} GB</span></span>
            <span>总和: <span className="text-gray-300 font-mono">{data.gpu.memory_total_gb.toFixed(1)} GB</span></span>
            <span className="text-gray-600 ml-auto">每 5s 刷新 · {data.stale ? '⚠ 缓存' : '✓ 实时'}</span>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * ComfyUI 磁盘模型 + 当前真实加载
 *
 * 数据源:
 *   /api/gpu/processes 的两个字段:
 *     - comfyui_models_on_disk: 后端 SSH 调 ComfyUI REST /models/{folder} 拿磁盘文件
 *     - comfyui_currently_loaded: 从 /history 最近 success 任务反推 Loader 节点, 真正在 GPU 上的模型
 *
 * 渲染规则:
 *   - 真正"当前加载" = filename 在 currently_loaded.filenames 里 (实时 5s 刷新)
 *   - 不在 = "磁盘但未加载", 默认折叠
 *   - currently_loaded 为 null (无 history / 解析失败) → 整个"已加载"区块降级为"⚠ 未知", 不再硬显示默认值
 *   - 不在 H3_MODEL_META 表里但又在 currently_loaded 的文件 (e.g. acestep) → 走"未识别模型"灰色行展示
 */
const H3_MODEL_META: Record<string, { category: string; icon: string; size_gb: number }> = {
  'minimax_h3_fl2va_pruned_int8_convrot.safetensors': { category: 'DiT (主模型)', icon: '🧠', size_gb: 19.53 },
  'minimax_h3_video_vae_fp16.safetensors': { category: 'Video VAE', icon: '🎬', size_gb: 4.85 },
  'minimax_h3_audio_vae_fp32.safetensors': { category: 'Audio VAE', icon: '🔊', size_gb: 0.56 },
  'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors': { category: 'Text Encoder', icon: '📝', size_gb: 14.61 },
  'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors': { category: 'Turbo LoRA (8 步)', icon: '⚡', size_gb: 0.75 },
  'minimax_h3_ref2va_pruned_int8_convrot.safetensors': { category: 'Ref2VA (pruned int8)', icon: '🎯', size_gb: 19.53 },
  'minimax_h3_ref2va_pruned_fp8_scaled.safetensors': { category: 'Ref2VA (pruned fp8)', icon: '🎯', size_gb: 9.77 },
  'minimax_h3_ref2va_pruned_nvfp4.safetensors': { category: 'Ref2VA (pruned nvfp4)', icon: '🎯', size_gb: 5.00 },
  'minimax_h3_ref2va_pruned_bf16.safetensors': { category: 'Ref2VA (pruned bf16)', icon: '🎯', size_gb: 39.07 },
  'minimax_h3_ref2va_int8_convrot.safetensors': { category: 'Ref2VA (int8 convrot)', icon: '🎯', size_gb: 19.53 },
  'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors': { category: 'Turbo LoRA (4 步 768p)', icon: '⚡', size_gb: 0.75 },
  'minimax_h3_turbo_v4_pruned_comfyui.safetensors': { category: 'Turbo LoRA (v4)', icon: '⚡', size_gb: 0.75 },
}

type CurrentlyLoaded = {
  filenames: string[]
  sizes_bytes: Record<string, number>  // filename -> bytes (从后端 SSH find 拿全量)
  prompt_id: string
  timestamp_ms: number
  age_seconds: number | null
} | null

function ComfyuiModelsBlock({
  onDisk,
  currentlyLoaded,
  comfyProcess,
  totalGb,
}: {
  onDisk: { checkpoints: string[]; diffusion_models: string[]; vae: string[]; loras: string[]; text_encoders: string[] }
  currentlyLoaded: CurrentlyLoaded
  comfyProcess: { pid: number; used_memory_gb: number } | undefined
  totalGb: number
}) {
  const allOnDisk = Array.from(new Set([
    ...(onDisk.diffusion_models ?? []),
    ...(onDisk.vae ?? []),
    ...(onDisk.text_encoders ?? []),
    ...(onDisk.loras ?? []),
    ...(onDisk.checkpoints ?? []),
  ]))

  // 已知 H3 文件: meta 里有 + 显示名字用 meta.category
  const known = allOnDisk
    .map(f => ({ filename: f, meta: H3_MODEL_META[f] }))
    .filter((m): m is { filename: string; meta: { category: string; icon: string; size_gb: number } } => !!m.meta)

  // 真实加载判断: filename 在 currentlyLoaded.filenames set 里
  const loadedSet = new Set(currentlyLoaded?.filenames ?? [])
  const isLoaded = (fn: string) => loadedSet.has(fn)

  // 已加载 (只算已知 H3, 未知非 H3 模型走单独"未识别模型"行)
  const loadedEntries = known.filter(f => isLoaded(f.filename))
  const notLoadedEntries = known.filter(f => !isLoaded(f.filename))

  // 短文件名展示: 去 MiniMax 品牌前缀 (大小写不敏感), 中间出现的 minimax 保留
  function displayName(fn: string): string {
    return fn.replace(/^minimax_/i, '')
  }

  // 类别启发式: 音乐单独一档 (acestep, minimax_music3, h3 music)
  // 其余按目录 (视频/文本/checkpoint) + 文件名兜底
  const FOLDER_CATEGORY: Record<string, { label: string; icon: string }> = {
    diffusion_models: { label: '视频', icon: '🎬' },
    vae:              { label: '视频', icon: '🎬' },
    loras:            { label: '视频', icon: '🎬' },
    text_encoders:    { label: '文本', icon: '📝' },
    checkpoints:      { label: 'checkpoint', icon: '🖼️' },
  }
  const NAME_CATEGORY: Array<[RegExp, { label: string; icon: string }]> = [
    // 音乐优先 (music/acestep, 含 minimax_music3)
    [/music|acestep|^ace[._]/i,       { label: '音乐', icon: '🎵' }],
    [/seedvr|upscale|4x|2x/i,          { label: '超分', icon: '✨' }],
    [/qwen|clip|text_encoder|llm/i,    { label: '文本', icon: '📝' }],
    [/vae/i,                           { label: '视频', icon: '🎬' }],
    [/lora/i,                          { label: '视频', icon: '🎬' }],
  ]

  function categoryFor(fn: string): { label: string; icon: string } {
    // 先按目录
    for (const [folder, files] of Object.entries(onDisk)) {
      if (files?.includes(fn)) return FOLDER_CATEGORY[folder] ?? { label: 'checkpoint', icon: '🖼️' }
    }
    // 再按文件名
    for (const [pat, cat] of NAME_CATEGORY) {
      if (pat.test(fn)) return cat
    }
    return { label: 'checkpoint', icon: '🖼️' }
  }

  const loadedUnknownWithCat = (currentlyLoaded?.filenames ?? [])
    .filter(fn => !H3_MODEL_META[fn])
    .map(filename => ({ filename, category: categoryFor(filename) }))

  // 按 size_gb 降序
  function sortDesc<T extends { meta?: { size_gb: number }; filename: string }>(entries: T[]): T[] {
    return [...entries].sort((a, b) => {
      const sa = a.meta?.size_gb ?? 0
      const sb = b.meta?.size_gb ?? 0
      return sb - sa
    })
  }

  const loadedSorted = sortDesc(loadedEntries)
  const notLoadedSorted = sortDesc(notLoadedEntries)

  // 真实文件大小查找: 优先用 sizes_bytes (磁盘真实), 没有 fallback 到 H3_MODEL_META 估算
  const sizeBytes = currentlyLoaded?.sizes_bytes ?? {}
  function realSizeGb(filename: string, fallbackGb: number): number {
    const b = sizeBytes[filename]
    if (b && b > 0) return b / 1024 / 1024 / 1024
    return fallbackGb
  }

  const loadedStaticGb = loadedEntries.reduce((s, e) => s + realSizeGb(e.filename, e.meta.size_gb), 0)
  const notLoadedStaticGb = notLoadedEntries.reduce((s, e) => s + realSizeGb(e.filename, e.meta.size_gb), 0)

  function ModelRow({
    filename,
    meta,
    loaded,
  }: {
    filename: string
    meta: { category: string; icon: string; size_gb: number }
    loaded: boolean
  }) {
    const sizeGb = realSizeGb(filename, meta.size_gb)
    const pct = totalGb > 0 ? (sizeGb / totalGb) * 100 : 0
    return (
      <div key={filename} className="space-y-0.5">
        <div className="flex items-center justify-between text-xs gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className="text-sm flex-shrink-0">{meta.icon}</span>
            <span className={`truncate font-medium ${loaded ? 'text-gray-100' : 'text-gray-500'}`}>
              comfy-{meta.category}
            </span>
            {loaded && (
              <span className="text-[9px] text-accent bg-accent/10 px-1 rounded flex-shrink-0">已加载</span>
            )}
          </div>
          <div className={`font-mono flex-shrink-0 ${loaded ? 'text-gray-300' : 'text-gray-500'}`}>
            {sizeGb.toFixed(2)} GB
            <span className={`ml-1 ${loaded ? 'text-gray-500' : 'text-gray-600'}`}>({pct.toFixed(1)}%)</span>
          </div>
        </div>
        <div className={`text-[10px] pl-7 truncate font-mono ${loaded ? 'text-gray-500' : 'text-gray-600'}`} title={filename}>
          {displayName(filename)}
        </div>
        <div className="h-1.5 bg-bg rounded-full overflow-hidden">
          <div
            className={`h-full transition-all ${loaded ? 'bg-accent' : 'bg-gray-700'}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      </div>
    )
  }

  // 磁盘未加载行: 类别标签放最前 + 脱敏短名
  function NotLoadedRow({ filename, meta, category }: { filename: string; meta: { category: string; icon: string; size_gb: number }; category: { label: string; icon: string } }) {
    const sizeGb = realSizeGb(filename, meta.size_gb)
    const short = displayName(filename)
    return (
      <div className="flex items-center justify-between text-xs text-gray-500 pl-1 gap-2" title={`${meta.category}\n${filename}`}>
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-[9px] text-gray-500 bg-white/5 px-1 rounded flex-shrink-0">{category.icon} {category.label}</span>
          <span className="truncate font-mono text-[11px]">{short}</span>
        </div>
        <span className="font-mono text-gray-500 flex-shrink-0">
          {sizeGb.toFixed(2)} GB
        </span>
      </div>
    )
  }

  // 未识别但被加载的非 H3 模型 (e.g. acestep) — 用目录反推类别 + 真实文件大小
  // 标签放最前, 文件名用脱敏短名 (去掉 MiniMax_ 前缀)
  function UnknownLoadedRow({ filename, bytes, category }: { filename: string; bytes?: number; category: { label: string; icon: string } }) {
    const sizeGb = bytes ? bytes / 1024 / 1024 / 1024 : null
    const short = displayName(filename)
    return (
      <div className="flex items-center justify-between text-xs text-gray-300 pl-1 gap-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-[9px] text-warn bg-warn/10 px-1 rounded flex-shrink-0">{category.icon} {category.label}</span>
          <span className="truncate font-mono text-[11px]" title={filename}>{short}</span>
        </div>
        <span className="font-mono text-gray-300 flex-shrink-0">
          {sizeGb !== null ? `${sizeGb.toFixed(2)} GB` : '? GB'}
        </span>
      </div>
    )
  }

  const totalLoaded = loadedEntries.length + loadedUnknownWithCat.length
  const hasLoadedInfo = currentlyLoaded !== null

  return (
    <div className="pt-2 mt-2 border-t border-white/5 space-y-1.5">
      {/* === 已加载区块 === */}
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">
        {hasLoadedInfo ? (
          <span className="text-gray-300">
            🧠 ComfyUI 当前加载的模型 ({totalLoaded} 个 · 静态 {loadedStaticGb.toFixed(2)} GB)
          </span>
        ) : (
          <span className="text-warn">⚠ ComfyUI 加载状态未知 (无 history, 请先跑一个任务)</span>
        )}
      </div>

      {!hasLoadedInfo && (
        <div className="text-[10px] text-gray-600 pl-1">
          下方只列磁盘上的 H3 模型文件, 实际 GPU 上是否加载未知。
        </div>
      )}

      {hasLoadedInfo && totalLoaded === 0 && (
        <div className="text-[10px] text-gray-600 pl-1">
          最近任务未加载任何模型 ({currentlyLoaded?.filenames.length ?? 0} 个)
        </div>
      )}

      {loadedSorted.map(({ filename, meta }) => (
        <ModelRow key={filename} filename={filename} meta={meta} loaded={true} />
      ))}

      {loadedUnknownWithCat.map(({ filename, category }) => (
        <UnknownLoadedRow
          key={filename}
          filename={filename}
          bytes={currentlyLoaded?.sizes_bytes?.[filename]}
          category={category}
        />
      ))}

      {/* === 磁盘但未加载区块 === */}
      {notLoadedEntries.length > 0 && (
        <details className="group">
          <summary className="text-[10px] text-gray-500 uppercase tracking-wide pt-2 cursor-pointer list-none flex items-center justify-between hover:text-gray-400 select-none">
            <span className="flex items-center gap-1">
              <span className="inline-block transition-transform group-open:rotate-90 text-[8px]">▶</span>
              磁盘 H3 模型 (未加载 · {notLoadedEntries.length} 个 · {notLoadedStaticGb.toFixed(2)} GB)
            </span>
            <span className="text-gray-600 text-[9px] normal-case font-normal">
              {notLoadedEntries.length > 1 ? '点击展开/收起' : ''}
            </span>
          </summary>

          {notLoadedSorted[0] && (
            <NotLoadedRow
              filename={notLoadedSorted[0].filename}
              meta={notLoadedSorted[0].meta}
              category={categoryFor(notLoadedSorted[0].filename)}
            />
          )}

          {notLoadedEntries.length > 1 && (
            <div className="space-y-0.5">
              {notLoadedSorted.slice(1).map(({ filename, meta }) => (
                <NotLoadedRow
                  key={filename}
                  filename={filename}
                  meta={meta}
                  category={categoryFor(filename)}
                />
              ))}
            </div>
          )}
        </details>
      )}

      {/* === ComfyUI 进程 VRAM 对比 === */}
      {comfyProcess && (
        <div className="pt-2 mt-1 border-t border-white/5 text-[10px] text-gray-500 flex flex-wrap gap-x-3 gap-y-1">
          <span>ComfyUI 进程 <span className="text-gray-400 font-mono">PID {comfyProcess.pid}</span>:</span>
          <span className="text-accent font-mono">{comfyProcess.used_memory_gb.toFixed(2)} GB</span>
          {loadedStaticGb > 0 ? (
            <span className="text-gray-600">
              (静态加载 {loadedStaticGb.toFixed(2)} GB ·{' '}
              {comfyProcess.used_memory_gb > loadedStaticGb
                ? `实际多 ${(comfyProcess.used_memory_gb - loadedStaticGb).toFixed(2)} GB = 运行时 / KV cache`
                : `实际少 ${(loadedStaticGb - comfyProcess.used_memory_gb).toFixed(2)} GB = 共享显存`})
            </span>
          ) : hasLoadedInfo ? (
            <span className="text-gray-600">(当前任务无 H3 静态模型)</span>
          ) : null}
        </div>
      )}
    </div>
  )
}


/**
 * 1 小时 GPU 显存历史柱状图
 *
 * 每 5 秒一个柱子,共最多 720 根 (1h)
 * - X 轴:时间(过去 1h),左老右新
 * - Y 轴:已用显存 (GB),固定 max = total_gb
 * - 颜色: <60% 绿, 60-85% 黄, >85% 红
 * - 鼠标 hover 显示时间戳和具体数值
 */
function GpuHistoryChart({ totalGb }: { totalGb: number }) {
  const [history, setHistory] = useState<GpuHistoryResp | null>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/gpu/history?seconds=3600')
      if (!r.ok) return
      const d: GpuHistoryResp = await r.json()
      setHistory(d)
    } catch {
      // silent
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  // 把 samples 渲染成柱状图
  // samples 是从老到新,我们直接铺满整条 bar
  const samples = history?.samples ?? []
  const hasData = samples.length > 0
  const maxGb = totalGb  // Y 轴最大值固定 = 总显存
  const maxSlots = history?.max_samples ?? 720

  return (
    <div className="bg-bg-card rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-gray-400">显存占用 · 过去 1 小时</div>
        <div className="text-xs text-gray-500 font-mono">
          {hasData ? `${samples.length}/${maxSlots} 样本` : '采集中…'}
        </div>
      </div>

      {/* 柱状图主体 - 固定 80px 高 */}
      <div className="relative h-20 bg-bg rounded-lg overflow-hidden">
        {!hasData ? (
          <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-xs">
            等待采样 (5s 后第 1 根柱子)
          </div>
        ) : (
          <div className="absolute inset-0 flex items-end">
            {samples.map((s, i) => {
              const pct = (s.used_gb / maxGb) * 100
              const color = pct > 85 ? 'bg-err' : pct > 60 ? 'bg-warn' : 'bg-accent'
              return (
                <div
                  key={s.t}
                  className={`flex-1 ${color} opacity-80 hover:opacity-100 transition-opacity`}
                  style={{ height: `${pct}%`, minWidth: '1px' }}
                  onMouseEnter={() => setHoverIdx(i)}
                  onMouseLeave={() => setHoverIdx(null)}
                  title={`${new Date(s.t * 1000).toLocaleTimeString()} - ${s.used_gb.toFixed(1)} GB`}
                />
              )
            })}
            {/* 如果柱子很少,把空白处填灰 */}
            {samples.length < maxSlots && (
              <div className="flex-1" />
            )}
          </div>
        )}

        {/* Y 轴刻度线 - 25%, 50%, 75% */}
        {[25, 50, 75].map(p => (
          <div
            key={p}
            className="absolute left-0 right-0 border-t border-white/5 pointer-events-none"
            style={{ top: `${100 - p}%` }}
          />
        ))}
      </div>

      {/* Hover 提示 */}
      <div className="mt-2 h-5 text-xs">
        {hasData && hoverIdx !== null && samples[hoverIdx] ? (
          <div className="font-mono text-gray-300">
            {new Date(samples[hoverIdx].t * 1000).toLocaleTimeString()}
            {' · '}
            <span className="text-accent">{samples[hoverIdx].used_gb.toFixed(1)} GB</span>
            {' / '}
            <span className="text-gray-500">{totalGb} GB</span>
            {' · '}
            <span className="text-gray-500">
              {((samples[hoverIdx].used_gb / totalGb) * 100).toFixed(0)}%
            </span>
          </div>
        ) : hasData ? (
          <div className="text-gray-600">悬停查看具体时间点的显存</div>
        ) : null}
      </div>

      {/* X 轴时间标签 */}
      <div className="flex justify-between text-[10px] text-gray-600 mt-1 px-0.5">
        <span>-1h</span>
        <span>-30m</span>
        <span>now</span>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-300 mb-2">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function TaskRow({ task, kind, queueIdx }: { task: any; kind: 'running' | 'pending'; queueIdx?: number }) {
  return (
    <div className="bg-bg-card rounded-xl p-3 flex items-start gap-3">
      <div className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
        kind === 'running' ? 'bg-warn animate-pulse' : 'bg-gray-600'
      }`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-200 line-clamp-2">
          {task.preview_prompt || '(no prompt text)'}
        </div>
        <div className="text-xs text-gray-500 mt-1">
          {kind === 'pending' && queueIdx !== undefined && <span className="text-accent">第 {queueIdx} 位 · </span>}
          <span className="font-mono">{task.prompt_id?.slice(0, 8) ?? '…'}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * Running 任务行 — 显眼的 step 进度 + 实时刷新的小进度条
 * 因为 ComfyUI 的 progress 是 step-based (H3 Turbo 8 步),不是百分比
 */
function RunningTaskRow({ task }: { task: any }) {
  // task.executing_step 是 /queue 列表返回的当前正在跑的节点,作为辅助标识
  // 但是 step 进度只有 WS 才有 — 这里只显示 prompt 和节点标识
  // 真实 step 进度在 ProgressCard 里显示(那是 WS 订阅的)
  const promptId = task.prompt_id?.slice(0, 8) ?? '…'
  const currentNode = task.executing_node ?? '?'
  return (
    <div className="bg-bg-card rounded-xl p-3 border border-warn/20">
      <div className="flex items-start gap-3 mb-2">
        <div className="mt-1 w-2 h-2 rounded-full flex-shrink-0 bg-warn animate-pulse" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-gray-200 line-clamp-2">
            {task.preview_prompt || '(no prompt text)'}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            <span className="font-mono text-warn">{promptId}</span>
            {' · '}
            <span>节点 {currentNode} 执行中</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-[10px] text-gray-500 uppercase tracking-wide">详情</span>
          <span className="text-xs text-accent">→ Generate Tab</span>
        </div>
      </div>
      {/* 加载中占位进度条 — 实际进度看 Generate Tab 的 ProgressCard */}
      <div className="h-1 bg-bg rounded-full overflow-hidden">
        <div className="h-full bg-gradient-to-r from-accent to-purple-500 animate-pulse" style={{ width: '60%' }} />
      </div>
    </div>
  )
}

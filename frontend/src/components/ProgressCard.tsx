import { useEffect, useRef, useState } from 'react'
import type { Submission } from '../lib/api'
import { api } from '../lib/api'

type OutputFile = {
  filename?: string
  subfolder?: string
  type?: string
  web_path?: string
  [k: string]: any
}

export default function ProgressCard({
  sub,
  promptText,
  onReset,
}: {
  sub: Submission
  promptText: string
  onReset?: () => void  // "再来一个"按钮回调 - 清空 activeSub 让用户提交新 prompt
}) {
  const pct = Math.round((sub.progress ?? 0) * 100)
  const isDone = sub.status === 'done'
  const isErr = sub.status === 'error'
  const isRunning = sub.status === 'running' || sub.status === 'submitted'

  // === 8 步模拟 (H3 Turbo 8 步采样)
  // 后端真实 progress_step 通常是 0..1 (polling dummy) — 用 elapsed 时间外推显示 8 段
  // 真实 done 事件抵达时, 锁定 finalStep = 8
  const TOTAL_STEPS = 8
  const EST_TOTAL_SEC = 90  // 实测 H3 832x480 8 步 Turbo ~90s
  const [simStep, setSimStep] = useState(0)

  useEffect(() => {
    if (isDone || isErr) {
      setSimStep(TOTAL_STEPS)
      return
    }
    if (!isRunning) return
    // 用 submitted_at + elapsed 算比例
    const tick = () => {
      const elapsed = (Date.now() / 1000) - sub.submitted_at
      // 8 步分布在 0..0.95 之间 (留 5% 给 "完成" 状态显示)
      const ratio = Math.min(0.95, elapsed / EST_TOTAL_SEC)
      const s = Math.min(TOTAL_STEPS - 1, Math.floor(ratio * TOTAL_STEPS))
      setSimStep(s)
    }
    tick()
    const t = setInterval(tick, 500)
    return () => clearInterval(t)
  }, [isDone, isErr, isRunning, sub.submitted_at])

  const displayStep = isDone ? TOTAL_STEPS : simStep
  const displayMax = TOTAL_STEPS

  // === 拿到视频 web_path (done 时)
  // 优先级: 1) done 事件里带的 web_path  2) snapshot.output_files 里带 web_path  3) 兜底查 /api/history
  const firstVideo = (sub.output_files ?? []).find(
    (f: OutputFile) => (f.filename ?? '').endsWith('.mp4')
  )
  const videoWebPath = firstVideo?.web_path ?? null

  const [fallbackVideoPath, setFallbackVideoPath] = useState<string | null>(null)
  const fallbackTriedRef = useRef(false)
  useEffect(() => {
    if (!isDone) return
    if (videoWebPath) return
    if (fallbackTriedRef.current) return
    fallbackTriedRef.current = true
    // 兜底: 拿最新 history 第一条 mp4 的 web_path (本机刚生成的)
    api.history(5).then((r) => {
      const mp4 = r.items.find((it) => it.filename.endsWith('.mp4'))
      if (mp4) setFallbackVideoPath(mp4.web_path)
    }).catch(() => {})
  }, [isDone, videoWebPath])

  const finalVideoUrl = videoWebPath ?? fallbackVideoPath

  // === 生成耗时 — 优先用 output_files[0].generation_sec (后端真值), 回退用 snapshot 字段
  const fileGenSec = firstVideo?.generation_sec as number | undefined
  const genSec = isDone
    ? (fileGenSec ?? (sub.finished_at ? sub.finished_at - sub.submitted_at : 0))
    : (Date.now() / 1000 - sub.submitted_at)
  const elapsedSec = Math.max(0, Math.round(genSec))

  const elapsedLabel = elapsedSec < 60
    ? `${elapsedSec}s`
    : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`

  // === 真正生成时间 (人读)
  const submittedAtLabel = sub.submitted_at
    ? new Date(sub.submitted_at * 1000).toLocaleString('zh-CN', {
        hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    : null
  const finishedAtLabel = sub.finished_at
    ? new Date(sub.finished_at * 1000).toLocaleString('zh-CN', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    : null

  // === 估算剩余时间
  const remainingSec = isDone ? 0 : Math.max(0, EST_TOTAL_SEC - elapsedSec)

  return (
    <div className={`rounded-2xl p-4 space-y-4 animate-slide-up ${
      isErr ? 'bg-err/10 border border-err/30' :
      isDone ? 'bg-ok/10 border border-ok/30' :
      'bg-bg-card border border-accent/30'
    }`}>
      {/* === Header === */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot status={sub.status} />
          <span className="text-sm font-medium capitalize">
            {statusLabel(sub.status)}
          </span>
          {isRunning && remainingSec > 0 && (
            <span className="text-xs text-gray-500">
              · 约 {remainingSec}s
            </span>
          )}
          {isDone && (
            <span className="text-xs text-ok">
              · 用时 {elapsedLabel}
            </span>
          )}
        </div>
        <span className="text-xs text-gray-500 font-mono">
          #{sub.submission_id.slice(0, 8)}
        </span>
      </div>

      {/* === 真正生成时间 (开始 → 结束) === */}
      {isDone && submittedAtLabel && finishedAtLabel && (
        <div className="flex items-center gap-3 text-[10px] text-gray-500 px-1">
          <span title="提交时间">
            🕐 开始 <span className="text-gray-300 font-mono">{submittedAtLabel}</span>
          </span>
          <span className="text-gray-700">→</span>
          <span title="完成时间">
            完成 <span className="text-gray-300 font-mono">{finishedAtLabel}</span>
          </span>
          {fileGenSec !== undefined && (
            <span className="ml-auto text-ok font-mono">
              {fileGenSec}s
            </span>
          )}
        </div>
      )}

      {/* === Prompt 预览 === */}
      <p className="text-xs text-gray-400 line-clamp-2 italic">
        "{promptText.slice(0, 120)}{promptText.length > 120 ? '…' : ''}"
      </p>

      {/* === 8 步进度条 === */}
      {(isRunning || isDone) && (
        <div className="space-y-2">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wide">H3 · 8 步 Turbo</div>
              <div className="flex items-baseline gap-1">
                <span className={`text-3xl font-bold font-mono ${
                  isDone ? 'text-ok' : 'text-accent'
                }`}>
                  {displayStep}
                </span>
                <span className="text-base text-gray-500 font-mono">
                  /{displayMax}
                </span>
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                {isDone ? '✅ 已完成' : STEP_LABELS[displayStep]}
              </div>
            </div>
          </div>

          {/* === 8 段进度 chip (每段一个独立小条) — 唯一进度指示 */}
          <div className="grid grid-cols-8 gap-1.5">
            {Array.from({ length: TOTAL_STEPS }).map((_, i) => {
              let cls = 'bg-white/10'
              if (i < displayStep) cls = 'bg-ok'  // 完成
              else if (i === displayStep && !isDone) cls = 'bg-accent animate-pulse'  // 当前
              return (
                <div
                  key={i}
                  className={`h-2 rounded-full transition-all ${cls}`}
                  title={`步骤 ${i + 1}: ${STEP_LABELS[i]}`}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* === 错误 === */}
      {isErr && sub.error && (
        <p className="text-xs text-err break-all">⚠ {sub.error}</p>
      )}

      {/* === 排队提示 === */}
      {sub.status === 'submitted' && (
        <p className="text-xs text-gray-500">⏳ 等待 ComfyUI 启动这个任务…</p>
      )}

      {/* === 完成 — 视频预览 (控件禁用) + 下载 === */}
      {isDone && (
        <div className="space-y-3 pt-1">
          {finalVideoUrl ? (
            <>
              <VideoPreview src={finalVideoUrl} />
              <div className="flex items-center gap-2">
                <a
                  href={finalVideoUrl}
                  download
                  className="flex-1 text-center text-xs text-gray-300 hover:text-accent transition py-2 px-3 rounded-lg bg-bg hover:bg-bg-hover flex flex-col items-center leading-tight"
                  title="下载 MP4 到本地"
                >
                  <span>⬇ 下载视频</span>
                  <span className="text-[10px] text-gray-600">Download MP4</span>
                </a>
                <a
                  href={finalVideoUrl}
                  target="_blank"
                  rel="noopener"
                  className="flex-1 text-center text-xs text-gray-400 hover:text-accent transition py-2 px-3 rounded-lg bg-bg hover:bg-bg-hover flex flex-col items-center leading-tight"
                  title="在新窗口打开视频"
                >
                  <span>↗ 打开预览</span>
                  <span className="text-[10px] text-gray-600">Open in new tab</span>
                </a>
                {onReset && (
                  <button
                    onClick={onReset}
                    className="flex-1 text-center text-sm font-medium text-white bg-accent hover:bg-accent-glow transition py-2 px-3 rounded-lg flex flex-col items-center leading-tight"
                  >
                    <span>✨ 再来一个</span>
                    <span className="text-[10px] font-normal opacity-70">Generate another</span>
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              正在准备视频预览…
              {onReset && (
                <button
                  onClick={onReset}
                  className="ml-auto text-xs text-gray-500 hover:text-accent underline"
                >
                  ↶ 重新开始
                </button>
              )}
            </div>
          )}

          <a
            href="/#history"
            target="_self"
            className="block text-center text-xs text-gray-500 hover:text-gray-300 transition pt-1"
          >
            全部视频看 History Tab ↗
            <span className="block text-[10px] text-gray-600">View all in History Tab</span>
          </a>
        </div>
      )}
    </div>
  )
}

// === H3 8 步 Turbo 节点标签 (按 workflow 顺序, 跟 ComfyUI 节点对应)
const STEP_LABELS = [
  '① 加载模型',     // 0
  '② 编码 Prompt',  // 1
  '③ 准备 Latent',  // 2
  '④ 加载 LoRA',    // 3
  '⑤ Sigma Shift',  // 4
  '⑥ 调度采样',     // 5
  '⑦ 8 步采样',     // 6
  '⑧ VAE 解码 + 保存', // 7
]

/** 视频预览组件 — 禁用原生控件, 自绘播放/暂停按钮 + 静音切换
 *  - 默认显示 cover.jpg 静态图, 用户点 ▶ 才加载视频
 *  - controlsList="nodownload nofullscreen noremoteplayback" 关掉右键菜单
 *  - disablePictureInPicture + disableRemotePlayback 关掉画中画/远程播放
 *  - oncontextmenu preventDefault 关掉"另存为"
 */
function VideoPreview({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)  // 默认不播, 等用户点
  const [muted, setMuted] = useState(true)
  const [coverOk, setCoverOk] = useState(true)

  const startPlay = () => {
    setPlaying(true)
    requestAnimationFrame(() => {
      videoRef.current?.play().catch(() => {/* ignore */})
    })
  }

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation()
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      v.play()
      setPlaying(true)
    } else {
      v.pause()
      setPlaying(false)
    }
  }

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation()
    const v = videoRef.current
    if (!v) return
    v.muted = !v.muted
    setMuted(v.muted)
  }

  const openFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation()
    const v = videoRef.current
    if (!v) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      v.requestFullscreen().catch(() => {/* 用户拒绝或浏览器不支持 */})
    }
  }

  // 推断 cover.jpg URL — mp4 文件名形如 H3_studio_00041_.mp4,
// cover 文件名是同名前缀 + .cover.jpg (即 H3_studio_00041_.mp4.cover.jpg)
  const coverUrl = src + '.cover.jpg'

  return (
    <div
      className="relative w-full aspect-video rounded-lg overflow-hidden bg-black group"
      onContextMenu={(e) => e.preventDefault() /* 禁右键"另存为" */}
      onDoubleClick={openFullscreen}
    >
      {!playing ? (
        <>
          {/* cover.jpg (优先) — 加载失败自动隐藏, 显示黑底 + 播放按钮 */}
          {coverOk && (
            <img
              src={coverUrl}
              alt="preview"
              className="absolute inset-0 w-full h-full object-cover"
              onError={() => setCoverOk(false)}
            />
          )}
          {/* cover 缺失兜底 */}
          {!coverOk && (
            <div className="absolute inset-0 flex items-center justify-center text-gray-600">
              <span className="text-xs">🎬 无封面</span>
            </div>
          )}
          {/* 中央 ▶ 按钮 */}
          <button
            type="button"
            onClick={startPlay}
            className="absolute inset-0 m-auto w-16 h-16 rounded-full bg-white/85 hover:bg-white text-black flex items-center justify-center text-2xl shadow-2xl hover:scale-105 transition z-10"
            title="播放"
          >
            ▶
          </button>
        </>
      ) : (
        <>
          <video
            ref={videoRef}
            src={src}
            autoPlay
            loop
            muted
            playsInline
            preload="metadata"
            disablePictureInPicture
            disableRemotePlayback
            controlsList="nodownload nofullscreen noremoteplayback"
            onClick={togglePlay}
            className="w-full h-full object-cover cursor-pointer"
          />
          {/* === 暂停时常显 ▶ 按钮 === */}
          <div
            className={`absolute inset-0 flex items-center justify-center pointer-events-none transition ${
              /* 这里用 opacity transition 太复杂, 简化: 不显中央按钮, hover 才显控制条 */
              'opacity-0'
            }`}
          />
        </>
      )}

      {/* === 右下角控制条 (仅播放状态时 hover 可见) === */}
      {playing && (
        <div className="absolute bottom-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
          <button
            onClick={togglePlay}
            className="w-8 h-8 rounded-full bg-black/60 hover:bg-black/80 text-white text-sm flex items-center justify-center backdrop-blur"
            title="暂停"
          >
            ⏸
          </button>
          <button
            onClick={toggleMute}
            className="w-8 h-8 rounded-full bg-black/60 hover:bg-black/80 text-white text-sm flex items-center justify-center backdrop-blur"
            title={muted ? '取消静音' : '静音'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      )}
      {/* === 顶部标签 === */}
      <div className="absolute top-2 left-2 text-[10px] text-white/60 bg-black/40 px-2 py-0.5 rounded backdrop-blur pointer-events-none">
        PREVIEW · 双击全屏
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: Submission['status'] }) {
  const cls = {
    pending: 'bg-gray-500',
    submitted: 'bg-gray-400 animate-pulse',
    running: 'bg-warn animate-pulse',
    done: 'bg-ok',
    error: 'bg-err',
  }[status]
  return <span className={`w-2.5 h-2.5 rounded-full ${cls}`} />
}

function statusLabel(s: Submission['status']) {
  return {
    pending: '排队中',
    submitted: '已提交',
    running: '生成中',
    done: '完成',
    error: '失败',
  }[s]
}
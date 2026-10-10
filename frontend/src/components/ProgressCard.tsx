import { useEffect, useRef, useState } from 'react'
import type { Submission } from '../lib/api'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'

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
  const { t } = useT()
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
            {statusLabel(sub.status, t)}
          </span>
          {isRunning && remainingSec > 0 && (
            <span className="text-xs text-gray-500">
              · {t('progress.remaining', { n: remainingSec })}
            </span>
          )}
          {isDone && (
            <span className="text-xs text-ok">
              · {t('progress.took', { t: elapsedLabel })}
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
          <span title={t('progress.submittedTitle')}>
            🕐 {t('progress.started')} <span className="text-gray-300 font-mono">{submittedAtLabel}</span>
          </span>
          <span className="text-gray-700">→</span>
          <span title={t('progress.finishedTitle')}>
            {t('progress.finished')} <span className="text-gray-300 font-mono">{finishedAtLabel}</span>
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
              <div className="text-[10px] text-gray-500 uppercase tracking-wide">{t('progress.h3Turbo')}</div>
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
                {isDone ? t('progress.completed') : t(`progress.steps.${displayStep}`)}
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
                  title={t('progress.stepLabel', { n: i + 1 }) + ': ' + t(`progress.steps.${i}`)}
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
        <p className="text-xs text-gray-500">{t('progress.waitingComfy')}</p>
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
                  title={t('progress.downloadTitle')}
                >
                  <span>⬇ {t('progress.downloadVideo').replace('⬇ ', '')}</span>
                  <span className="text-[10px] text-gray-600">{t('progress.downloadMp4')}</span>
                </a>
                <a
                  href={finalVideoUrl}
                  target="_blank"
                  rel="noopener"
                  className="flex-1 text-center text-xs text-gray-400 hover:text-accent transition py-2 px-3 rounded-lg bg-bg hover:bg-bg-hover flex flex-col items-center leading-tight"
                  title={t('progress.openTitle')}
                >
                  <span>↗ {t('progress.openPreview').replace('↗ ', '')}</span>
                  <span className="text-[10px] text-gray-600">{t('progress.openInTab')}</span>
                </a>
                {onReset && (
                  <button
                    onClick={onReset}
                    className="flex-1 text-center text-sm font-medium text-white bg-accent hover:bg-accent-glow transition py-2 px-3 rounded-lg flex flex-col items-center leading-tight"
                  >
                    <span>✨ {t('progress.generateAnother').replace('✨ ', '')}</span>
                    <span className="text-[10px] font-normal opacity-70">{t('progress.generateAnotherEn')}</span>
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              {t('progress.preparingVideo')}
              {onReset && (
                <button
                  onClick={onReset}
                  className="ml-auto text-xs text-gray-500 hover:text-accent underline"
                >
                  {t('progress.restart')}
                </button>
              )}
            </div>
          )}

          <a
            href="/#history"
            target="_self"
            className="block text-center text-xs text-gray-500 hover:text-gray-300 transition pt-1"
          >
            {t('progress.viewAllHistory')}
            <span className="block text-[10px] text-gray-600">{t('progress.viewAllHistoryEn')}</span>
          </a>
        </div>
      )}
    </div>
  )
}

// === H3 8 步 Turbo 节点标签 (字典走 t(`progress.steps.${i}`), 此处保留作为 fallback)
// 当前已完全用 i18n, 留空数组仅占位避免编译错
const STEP_LABELS: string[] = []

/** 视频预览组件 — 禁用原生控件, 自绘播放/暂停按钮 + 静音切换
 *  - 默认显示 cover.jpg 静态图, 用户点 ▶ 才加载视频
 *  - controlsList="nodownload nofullscreen noremoteplayback" 关掉右键菜单
 *  - disablePictureInPicture + disableRemotePlayback 关掉画中画/远程播放
 *  - oncontextmenu preventDefault 关掉"另存为"
 */
function VideoPreview({ src }: { src: string }) {
  const { t } = useT()
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
              <span className="text-xs">{t('progress.noCover')}</span>
            </div>
          )}
          {/* 中央 ▶ 按钮 */}
          <button
            type="button"
            onClick={startPlay}
            className="absolute inset-0 m-auto w-16 h-16 rounded-full bg-white/85 hover:bg-white text-black flex items-center justify-center text-2xl shadow-2xl hover:scale-105 transition z-10"
            title={t('progress.playTitle')}
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
            title={t('progress.pauseTitle')}
          >
            ⏸
          </button>
          <button
            onClick={toggleMute}
            className="w-8 h-8 rounded-full bg-black/60 hover:bg-black/80 text-white text-sm flex items-center justify-center backdrop-blur"
            title={muted ? t('progress.unmuteTitle') : t('progress.muteTitle')}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        </div>
      )}
      {/* === 顶部标签 === */}
      <div className="absolute top-2 left-2 text-[10px] text-white/60 bg-black/40 px-2 py-0.5 rounded backdrop-blur pointer-events-none">
        {t('progress.previewLabel')}
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

function statusLabel(s: Submission['status'], t: (p: string) => string) {
  return {
    pending: t('progress.statusPending'),
    submitted: t('progress.statusSubmitted'),
    running: t('progress.statusRunning'),
    done: t('progress.statusDone'),
    error: t('progress.statusError'),
  }[s]
}
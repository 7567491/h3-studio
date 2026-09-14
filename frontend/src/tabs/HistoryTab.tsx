import { useState, useEffect, useRef } from 'react'
import { api, type HistoryItem } from '../lib/api'

/**
 * 历史视频 Tab - 自渲染极简画廊
 *
 * 为什么不直接 iframe 嵌入 sibling viewer:
 * - sibling viewer 有 header + sidebar + 排序, 手机看太挤
 * - iframe 跨页面跳转容易丢失本应用的页面状态
 *
 * 这里直接调 sibling viewer 的 /api/history 接口(同一个 uploads 共享目录),
 * 完全按 mobile-first 自渲染:
 * - 手机 (<640px): 2 列缩略图,标题/分类/排序全部隐藏
 * - PC (>=640px): 3-4 列,hover 视频预览
 */
export default function HistoryTab() {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const refresh = useEffect(() => {
    api.history(60)
      .then((r) => setItems(r.items))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="animate-slide-up">
        <h2 className="text-2xl font-bold mb-3">历史视频</h2>
        <div className="text-center text-gray-500 py-12">加载中…</div>
      </div>
    )
  }

  if (err) {
    return (
      <div className="animate-slide-up">
        <h2 className="text-2xl font-bold mb-3">历史视频</h2>
        <div className="bg-err/10 border border-err/30 rounded-2xl p-4 text-err text-sm">
          ⚠ {err}
        </div>
      </div>
    )
  }

  return (
    <div className="animate-slide-up">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-2xl font-bold">历史视频</h2>
          <p className="text-xs text-gray-500 mt-1">{items.length} 个视频 · 实时同步</p>
          <p className="text-[10px] text-gray-600">History · {items.length} videos, live</p>
        </div>
        {/*
          完整画廊链接 — 默认隐藏 (clone 后用户自己配置 VITE_GALLERY_URL)。
          生产部署时在 frontend/.env.local 或 nginx 反代时设 VITE_GALLERY_URL。
        */}
        {import.meta.env.VITE_GALLERY_URL ? (
          <a
            href={String(import.meta.env.VITE_GALLERY_URL)}
            target="_blank"
            rel="noopener"
            className="text-xs text-gray-500 hover:text-accent transition whitespace-nowrap flex flex-col items-end leading-tight"
          >
            <span>完整画廊 ↗</span>
            <span className="text-[10px] text-gray-600">Full gallery</span>
          </a>
        ) : null}
      </div>

      {/* 视频 grid - 自适应列数 */}
      {/* 手机默认 2 列,sm 以上 3 列,lg 以上 4 列 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
        {items.map(v => (
          <VideoCard
            // 用 web_path 做 React key (含日期子目录), 不用 slug
            // 因为 orphan_recovery 2026-09-04 把 9-03 的 56 个孤儿复制到 9-04/9-05,
            // 跨日期目录里 slug 会重复 (MD5 完全相同). web_path 全局唯一.
            key={v.web_path}
            v={v}
            onDeleted={(slug) => {
              // 从本地 list 立即移除 (无需等下一次 refresh)
              setItems(prev => prev.filter(it => it.slug !== slug))
            }}
          />
        ))}
      </div>

      {items.length === 0 && (
        <div className="text-center text-gray-500 py-12">
          <div className="text-4xl mb-2">🎬</div>
          <div>暂无视频</div>
        </div>
      )}
    </div>
  )
}

/**
 * 单个视频卡片 — inline 自动循环播放 (mobile-first)
 * - 移动端:直接显示 <video autoplay loop muted> 循环预览,无需点击
 * - PC 端:相同行为 (一致体验)
 * - 点击 → 弹 modal 大预览 + 下载按钮 (避免跳新窗口)
 * - cover.jpg 仅作 poster (视频加载前的占位图)
 */
function VideoCard({ v, onDeleted }: { v: HistoryItem; onDeleted: (slug: string) => void }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)

  const doDelete = async () => {
    setDeleting(true)
    setDeleteErr(null)
    try {
      // 软删除 (2026-09-06): 传 upload_date 帮后端快速定位, 不用扫全目录
      // 文件保留在磁盘, 只在前端不可见
      await api.deleteVideo(v.filename, v.upload_date)
      setDeleteOpen(false)
      onDeleted(v.slug)  // 通知父组件从列表里移除
    } catch (e: any) {
      setDeleteErr(e.message ?? '隐藏失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <div
        className="block w-full text-left group bg-bg-card rounded-lg overflow-hidden hover:bg-bg-hover transition cursor-pointer relative"
        onClick={() => setModalOpen(true)}
      >
        {/* 视频预览区 — 16:9 自动循环 (inline, 无需点击) */}
        <div className="relative aspect-video bg-black overflow-hidden">
          <video
            src={v.web_path}
            muted
            loop
            autoPlay
            playsInline
            preload="metadata"
            poster={`${v.web_path}.cover.jpg`}
            className="w-full h-full object-cover"
          />
          {/* 参考图标记: 用过 ref_image 的视频在右上角显示 📌 */}
          {v.meta?.ref_image && (
            <span
              className="absolute top-1 right-1 bg-accent/80 text-white text-[10px] px-1.5 py-0.5 rounded pointer-events-none"
              title={`参考图: ${v.meta.ref_image}`}
            >
              📌 ref
            </span>
          )}
          {/* 时长角标 */}
          {v.meta?.duration && (
            <span className="absolute bottom-1 right-1 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded pointer-events-none">
              {v.meta.duration}
            </span>
          )}
          {/* 生成耗时角标 (左下) — 真实数据 */}
          {v.meta?.generation_sec != null && (
            <span className="absolute bottom-1 left-1 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded pointer-events-none">
              ⏱ {v.meta.generation_sec}s
            </span>
          )}
          {/* 🙈 隐藏按钮 — hover 才显, 在左下角 (跟 ref 错开)
              软删除 (2026-09-06): 文件保留, 前端不可见 */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()  // 防止触发 card onClick
              setDeleteOpen(true)
            }}
            className="absolute bottom-1 left-1 w-7 h-7 rounded-full bg-black/60 hover:bg-warn text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition backdrop-blur"
            title="隐藏视频 (前端不再显示)"
          >
            🙈
          </button>
        </div>

        {/* 标题 - 仅 PC/平板显示,手机隐藏节省空间 */}
        <div className="p-2 hidden sm:block">
          <div className="text-xs font-medium truncate group-hover:text-accent transition">
            {v.title}
          </div>
          <div className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-1.5">
            <span>{(v.size / 1024 / 1024).toFixed(1)} MB</span>
            {v.meta?.submitted_at_iso && (
              <>
                <span>·</span>
                <span className="font-mono">{v.meta.submitted_at_iso.split('T')[1]}</span>
              </>
            )}
            {v.meta?.category && v.meta.category !== '—' && (
              <>
                <span>·</span>
                <span className="truncate">{v.meta.category}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 大预览 modal — 点击视频卡片后弹出 */}
      {modalOpen && (
        <VideoModal v={v} onClose={() => setModalOpen(false)} />
      )}

      {/* 删除确认 modal — 点 🗑 按钮后弹出 */}
      {deleteOpen && (
        <DeleteConfirmModal
          v={v}
          deleting={deleting}
          error={deleteErr}
          onConfirm={doDelete}
          onCancel={() => {
            setDeleteOpen(false)
            setDeleteErr(null)
          }}
        />
      )}
    </>
  )
}

/** 隐藏确认 modal — 二次确认防误操作
 *  软删除 (2026-09-06): 视频文件保留在磁盘, 只是前端不再显示 */
function DeleteConfirmModal({
  v, deleting, error, onConfirm, onCancel,
}: {
  v: HistoryItem
  deleting: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, deleting])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur flex items-center justify-center p-4 animate-slide-up"
      onClick={() => !deleting && onCancel()}
    >
      <div
        className="bg-bg-card rounded-2xl max-w-md w-full p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-warn/20 flex items-center justify-center text-warn text-xl flex-shrink-0">
            🙈
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-medium text-white">隐藏视频?</h3>
            <p className="text-xs text-gray-500 mt-0.5">前端不再显示 · 文件保留在服务器</p>
          </div>
        </div>

        <div className="text-sm text-gray-300 bg-bg rounded-lg p-3 space-y-1">
          <div className="text-xs text-gray-500 mb-1">要隐藏的视频:</div>
          <div className="truncate font-medium">{v.title}</div>
          <div className="text-xs text-gray-500 font-mono">{v.filename}</div>
          <div className="text-xs text-gray-500">
            {(v.size / 1024 / 1024).toFixed(1)} MB
            {v.meta?.generation_sec != null && ` · 生成耗时 ${v.meta.generation_sec}s`}
          </div>
        </div>

        <div className="text-xs text-gray-500 bg-warn/5 border border-warn/20 rounded-lg p-2 leading-relaxed">
          💡 文件保留在服务器磁盘上, 仅从前端列表中移除。
          如果以后需要, SSH 到服务器手动编辑 .meta.json 删除 <code className="text-warn">hidden</code> 字段可恢复显示。
        </div>

        {error && (
          <div className="text-xs text-err bg-err/10 border border-err/30 rounded-lg p-2">
            ⚠ {error}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="flex-1 text-sm text-gray-300 hover:text-white bg-bg hover:bg-bg-hover border border-white/10 transition py-2 px-3 rounded-lg disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="flex-1 text-sm font-medium text-white bg-warn hover:bg-warn/80 transition py-2 px-3 rounded-lg flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {deleting ? (
              <>
                <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                隐藏中…
              </>
            ) : (
              <>🙈 确认隐藏</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 视频大预览 modal — 包含视频播放器 + 元数据 + 下载按钮 */
function VideoModal({ v, onClose }: { v: HistoryItem; onClose: () => void }) {
  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur flex items-center justify-center p-4 animate-slide-up"
      onClick={onClose}
    >
      <div
        className="bg-bg-card rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 关闭按钮 */}
        <div className="flex items-center justify-between p-3 border-b border-white/10">
          <h3 className="text-sm font-medium truncate">{v.title}</h3>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-bg hover:bg-bg-hover text-gray-300 hover:text-white flex items-center justify-center text-lg"
            title="关闭 (ESC)"
          >
            ✕
          </button>
        </div>

        {/* 视频预览 — 默认显示 cover.jpg 静态图 + ▶ 播放按钮
            用户点 ▶ 才切到视频播放器 (用 controls 完整 seek/scrub)
            好处: (1) 打开 modal 不被声音/动画干扰 (2) cover.jpg 缺失会自然显示视频首帧 */}
        <VideoPreviewInModal webPath={v.web_path} title={v.title} />

        {/* 元数据 + 操作 */}
        <div className="p-4 space-y-3">
          {/* 真正生成时间 */}
          {v.meta?.submitted_at_iso && v.meta?.finished_at_iso && (
            <div className="text-gray-400 text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-gray-500">🕐 提交:</span>
                <span className="font-mono text-gray-300">{v.meta.submitted_at_iso}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gray-500">✅ 完成:</span>
                <span className="font-mono text-gray-300">{v.meta.finished_at_iso}</span>
                {v.meta.generation_sec != null && (
                  <span className="ml-auto text-ok font-mono">⏱ {v.meta.generation_sec}s</span>
                )}
              </div>
            </div>
          )}

          {/* Prompt (如果有) */}
          {v.meta?.prompt && (
            <details className="text-xs">
              <summary className="text-gray-400 cursor-pointer hover:text-gray-300">
                📝 查看 prompt
              </summary>
              <p className="mt-2 text-gray-300 bg-bg rounded-lg p-3 max-h-40 overflow-y-auto leading-relaxed">
                {v.meta.prompt}
              </p>
            </details>
          )}

          {/* 操作按钮 */}
          <div className="flex items-center gap-2 pt-2">
            <a
              href={v.web_path}
              download
              className="flex-1 text-center text-xs text-gray-300 hover:text-accent transition py-2 px-3 rounded-lg bg-bg hover:bg-bg-hover flex flex-col items-center leading-tight"
            >
              <span>⬇ 下载视频</span>
              <span className="text-[10px] text-gray-600">Download MP4</span>
            </a>
            <a
              href={v.web_path}
              target="_blank"
              rel="noopener"
              className="flex-1 text-center text-xs text-gray-400 hover:text-accent transition py-2 px-3 rounded-lg bg-bg hover:bg-bg-hover flex flex-col items-center leading-tight"
            >
              <span>↗ 新窗口打开</span>
              <span className="text-[10px] text-gray-600">Open in tab</span>
            </a>
          </div>

          <div className="text-[10px] text-gray-600 text-center pt-1">
            {(v.size / 1024 / 1024).toFixed(1)} MB · {v.filename}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Modal 内的视频预览 — cover.jpg 静态图 + ▶ 按钮 + 真视频播放器
 *  - 默认状态: 显示 cover.jpg, 中间浮一个 ▶ 按钮 (大, 圆, 半透明)
 *  - 点击 ▶ → 切换到 <video controls>, 加载 + 自动播放
 *  - cover.jpg 缺失 → 显示"无封面"占位 + ▶ 按钮 (点照样能播视频)
 */
function VideoPreviewInModal({ webPath, title }: { webPath: string; title: string }) {
  const [playing, setPlaying] = useState(false)
  const [coverOk, setCoverOk] = useState(true)
  const videoRef = useRef<HTMLVideoElement>(null)

  // 点 ▶ → 切到视频播放器并自动播放
  const startPlay = () => {
    setPlaying(true)
    // 切到 video 后立刻 play() (autoplay 已在 video 标签上, 但保险起见)
    requestAnimationFrame(() => {
      videoRef.current?.play().catch(() => {/* ignore */})
    })
  }

  return (
    <div className="bg-black relative aspect-video flex items-center justify-center overflow-hidden">
      {!playing ? (
        <>
          {/* cover.jpg (优先) — 加载失败自动隐藏 */}
          {coverOk && (
            <img
              src={`${webPath}.cover.jpg`}
              alt={title}
              className="absolute inset-0 w-full h-full object-cover"
              onError={() => setCoverOk(false)}
            />
          )}
          {/* cover 缺失占位 */}
          {!coverOk && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600">
              <div className="text-5xl mb-2">🎬</div>
              <div className="text-xs">无封面预览</div>
            </div>
          )}
          {/* 中央 ▶ 播放按钮 (无黑色遮罩 — cover 已够暗, 不需要再遮) */}
          <button
            type="button"
            onClick={startPlay}
            className="relative z-10 w-20 h-20 rounded-full bg-white/85 hover:bg-white text-black flex items-center justify-center text-3xl shadow-2xl hover:scale-105 transition"
            title="播放视频"
          >
            ▶
          </button>
        </>
      ) : (
        /* 视频播放器 (controls 全功能 — 用户可 seek/scrub/调音量/全屏) */
        <video
          ref={videoRef}
          src={webPath}
          controls
          autoPlay
          playsInline
          preload="metadata"
          poster={`${webPath}.cover.jpg`}
          className="w-full h-full object-contain"
        />
      )}
    </div>
  )
}

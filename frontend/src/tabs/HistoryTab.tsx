import { useState, useEffect, useRef } from 'react'
import { api, type HistoryItem } from '../lib/api'
import { useT } from '../lib/i18n'

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
  const { t } = useT()
  const [items, setItems] = useState<HistoryItem[]>([])
  const [total, setTotal] = useState(0)        // 后端报告的总可见数
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)       // 下一次拉取的起始 offset
  const [hasMore, setHasMore] = useState(true)  // 是否还有更多
  const [currentPage, setCurrentPage] = useState(0)  // 当前页 (0-based) — 直接用 offset 算, 不依赖 PAGE_SIZE
  // 一页 20 个 (2026-10-12 Jack 反馈 "每页显示20个"):
  // 之前 12 个, 现在 20. 20 = 4×5 (lg) 或 5×4, 缩略图网格美观.
  // Jack 不要"更多"按钮, 但 20 个一页翻页次数从 94 减到 57 次.
  const PAGE_SIZE = 20
  // 翻页控件位置 (2026-10-12): Jack 反馈滚到底再点 Load more 体验差, 把控件移最顶
  // 让用户先看到分页信息, 看完 10 个再决定加载更多. 底部只留一个 sentinel (无限滚动) 兜底.
  //
  // append=false (jumpToPage / 首次): 替换 items
  // append=true  (Load more):     追加 items
  const loadPage = (start: number, append: boolean) =>
    api.history(PAGE_SIZE, undefined, start)
      .then((r) => {
        setItems(prev => append ? [...prev, ...r.items] : r.items)
        setTotal(r.count)
        // 用后端返回的 has_more 直接判断 (start + items.length < r.count 是后备)
        setHasMore(r.has_more ?? ((start + r.items.length) < r.count))
        // offset 累积: 基于实际返回的 items 数 (不是 PAGE_SIZE), 因为有 hidden 视频会少几个
        const newOffset = start + r.items.length
        setOffset(newOffset)
        // currentPage = floor(offset / PAGE_SIZE), 用 offset 而非 items.length 算
        // 例: offset=19 → page=0 (第1页), offset=38 → page=1 (第2页), ...
        // 注意: 因为每页 items 数不固定 (受 hidden 影响), 这里用新 offset / PAGE_SIZE
        setCurrentPage(Math.floor(newOffset / PAGE_SIZE))
      })
      .catch((e) => setErr(e.message))

  // 首次加载 (offset=0, replace)
  useEffect(() => {
    loadPage(0, false).finally(() => setLoading(false))
  }, [])

  // "Load more" 追加
  const loadMore = () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    loadPage(offset, true).finally(() => setLoadingMore(false))
  }

  // 跳到第 N 页 (从 0 开始)
  const jumpToPage = (page: number) => {
    if (loading || loadingMore) return
    setLoading(true)
    // 直接算 offset: 每页 20 个, page 0 = offset 0, page 1 = offset 20, ...
    // (注意: 实际 items 可能不固定, 所以这里用 PAGE_SIZE * page 做近似值,
    // 后端会根据 offset 返回对应范围的数据)
    loadPage(page * PAGE_SIZE, false).finally(() => setLoading(false))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // 滚到底自动加载 (intersection observer) — 2026-10-12 Jack 反馈 "不要显示更多"
  // 之前用 sentinel 自动追加, 现在 sentinel 留个"到底了"的占位但不再触发 loadMore.
  const sentinelRef = useRef<HTMLDivElement>(null)
  // 移除自动加载 (2026-10-12): Jack 不要"更多", 滚到底不再追加.
  // useEffect 留个空架子以免 lint 报 unused vars.
  useEffect(() => { sentinelRef.current }, [])

  if (loading) {
    return (
      <div className="animate-slide-up">
        <h2 className="text-2xl font-bold mb-3">{t('history.title')}</h2>
        <div className="text-center text-gray-500 py-12">{t('common.loading')}</div>
      </div>
    )
  }

  if (err) {
    return (
      <div className="animate-slide-up">
        <h2 className="text-2xl font-bold mb-3">{t('history.title')}</h2>
        <div className="bg-err/10 border border-err/30 rounded-2xl p-4 text-err text-sm">
          ⚠ {err}
        </div>
      </div>
    )
  }

  return (
    <div className="animate-slide-up">
      {/* === 顶部控件 (2026-10-12 Jack 反馈): 翻页信息/按钮放最顶 === */}
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">{t('history.title')}</h2>
          <p className="text-xs text-gray-500 mt-1">
            {items.length} / {total} {t('history.count')}
          </p>
        </div>
        {/* 翻页: 上一页 / 当前页 / 下一页 (Load more 已移除 2026-10-12) */}
        {total > 0 && (
          <PaginationControl
            shown={items.length}
            total={total}
            pageSize={PAGE_SIZE}
            currentPage={currentPage}
            hasMore={hasMore}
            onJump={jumpToPage}
          />
        )}
        {import.meta.env.VITE_GALLERY_URL ? (
          <a
            href={String(import.meta.env.VITE_GALLERY_URL)}
            target="_blank"
            rel="noopener"
            className="text-xs text-gray-500 hover:text-accent transition whitespace-nowrap"
          >
            {t('history.fullGallery')}
          </a>
        ) : null}
      </div>

      {/* 视频 grid - 自适应列数 + 缩略图 (2026-10-12) */}
      {/* 手机默认 2 列,sm 以上 3 列,lg 以上 4 列 → 5 列等比放大 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3">
        {items.map(v => (
          <VideoCard
            // 用 web_path 做 React key (含日期子目录), 不用 slug
            // 因为 orphan_recovery 2026-09-04 把 9-03 的 56 个孤儿复制到 9-04/9-05,
            // 跨日期目录里 slug 会重复 (MD5 完全相同). web_path 全局唯一.
            key={v.web_path}
            v={v}
            onDeleted={(slug) => {
              setItems(prev => prev.filter(it => it.slug !== slug))
              setTotal(t => Math.max(0, t - 1))
            }}
          />
        ))}
      </div>

      {/* Load more 按钮已移除 (2026-10-12 Jack 反馈 "不要显示更多") */}
      {hasMore && !loadingMore && (
        <div className="text-center text-xs text-gray-600 py-4">
          — {t('history.moreOnNextPage', { left: total - items.length })} —
        </div>
      )}
      {loadingMore && (
        <div className="text-center text-xs text-gray-500 py-4">{t('common.loading')}</div>
      )}

      {!hasMore && items.length > 0 && (
        <div className="text-center text-xs text-gray-600 py-6">
          — {items.length} / {total} {t('history.count')} —
        </div>
      )}

      {items.length === 0 && (
        <div className="text-center text-gray-500 py-12">
          <div className="text-4xl mb-2">🎬</div>
          <div>{t('history.empty')}</div>
        </div>
      )}
    </div>
  )
}

/**
 * 翻页控件 — 2026-10-12 Jack 反馈后移最顶
 * 布局: ‹  [prev] page X / N [next] ›   |   Load more (shown/total)
 *
 *  - "跳页" 模式: 清空当前 items 重新拉, 用户想看第 30 页就直接点
 *  - "Load more" 模式: 追加, 不清空
 *
 * 渲染规则:
 *  - 总数 <= PAGE_SIZE*2: 只显示 "Load more" 一个按钮
 *  - 总数 > PAGE_SIZE*2: 显示 ‹ prev / next › + "Load more"
 *    - 数字页码只在总数 <= PAGE_SIZE*10 时显示 (1130/10=113, 不显示具体页码,
 *      改用 ‹ 1/113 › 简写)
 */
function PaginationControl({
  shown, total, pageSize, currentPage, hasMore, onJump,
}: {
  shown: number
  total: number
  pageSize: number
  currentPage: number
  hasMore: boolean
  onJump: (page: number) => void
}) {
  const { t } = useT()
  // currentPage 由父组件传入 (基于 offset 算), 不依赖 shown.length (hidden 的不算)
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {/* 跳页箭头 (总数 > 1 页时才显示) */}
      {(() => {
        const totalPages = Math.max(1, Math.ceil(total / pageSize))
        return totalPages > 1 && (
          <div className="flex items-center gap-0.5 text-xs">
            <button
              disabled={currentPage === 0}
              onClick={() => onJump(currentPage - 1)}
              className="w-7 h-7 rounded-full bg-bg-card hover:bg-bg-hover border border-gray-700 text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition"
              title={t('history.prevPage')}
            >
              ‹
            </button>
            <span className="text-gray-500 px-1 font-mono">
              {currentPage + 1} / {totalPages}
            </span>
            <button
              disabled={!hasMore}
              onClick={() => onJump(currentPage + 1)}
              className="w-7 h-7 rounded-full bg-bg-card hover:bg-bg-hover border border-gray-700 text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed transition"
              title={t('history.nextPage')}
            >
              ›
            </button>
          </div>
        )
      })()}
      {/* Load more 按钮已移除 (2026-10-12 Jack 反馈 "不要显示更多") */}
    </div>
  )
}

/**
 * 单个视频卡片 — 缩略图模式 (2026-10-12 Jack 反馈优化)
 * - 默认: 只显示 cover.jpg (17KB/张), hover 才加载 video
 *   避免 1100+ <video autoPlay> 同时请求 mp4 metadata
 * - 点击 → 弹 modal 大预览 (跟之前一样)
 * - cover.jpg 路径: web_path + ".cover.jpg"
 *   1122 个视频都已生成 cover.jpg (submit_manager 在提交后用 ffmpeg 抽第一帧)
 */
function VideoCard({ v, onDeleted }: { v: HistoryItem; onDeleted: (slug: string) => void }) {
  const { t } = useT()
  const [modalOpen, setModalOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)
  // hover 时才加载 video (preload=none → cover.jpg 立即显示, 视频按需)
  const [hovered, setHovered] = useState(false)

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
      setDeleteErr(e.message ?? t('history.hideFailed'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <div
        className="block w-full text-left group bg-bg-card rounded-lg overflow-hidden hover:bg-bg-hover transition cursor-pointer relative"
        onClick={() => setModalOpen(true)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* 缩略图区 — 16:9, 默认显示 cover.jpg (17KB), hover 才加载 video */}
        <div className="relative aspect-video bg-black overflow-hidden">
          {/* 缩略图: cover.jpg, lazy load (loading="lazy" 让浏览器自动控制) */}
          <img
            src={`${v.web_path}.cover.jpg`}
            alt={v.title}
            loading="lazy"
            decoding="async"
            className={`absolute inset-0 w-full h-full object-cover transition-opacity ${
              hovered ? 'opacity-0' : 'opacity-100'
            }`}
            draggable={false}
            onError={(e) => {
              // cover.jpg 不存在 (老视频) → fallback 显示 video 第一帧 (默认行为)
              (e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
          {/* 视频预览: 仅 hover 时才插入 (preload="auto" 让 hover 立即有反馈) */}
          {hovered && (
            <video
              src={v.web_path}
              muted
              loop
              autoPlay
              playsInline
              preload="auto"
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}
          {/* 参考图标记: 用过 ref_image 的视频在右上角显示 📌 */}
          {v.meta?.ref_image && (
            <span
              className="absolute top-1 right-1 bg-accent/80 text-white text-[10px] px-1.5 py-0.5 rounded pointer-events-none"
              title={`参考图: ${v.meta.ref_image}`}
            >
              {t('history.refBadge')}
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
            title={t('history.hideVideo')}
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
  const { t } = useT()
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
            <h3 className="text-base font-medium text-white">{t('history.hideConfirmTitle')}</h3>
            <p className="text-xs text-gray-500 mt-0.5">{t('history.hideConfirmDesc')}</p>
          </div>
        </div>

        <div className="text-sm text-gray-300 bg-bg rounded-lg p-3 space-y-1">
          <div className="text-xs text-gray-500 mb-1">{t('history.hideTarget')}</div>
          <div className="truncate font-medium">{v.title}</div>
          <div className="text-xs text-gray-500 font-mono">{v.filename}</div>
          <div className="text-xs text-gray-500">
            {(v.size / 1024 / 1024).toFixed(1)} MB
            {v.meta?.generation_sec != null && ` · 生成耗时 ${v.meta.generation_sec}s`}
          </div>
        </div>

        <div className="text-xs text-gray-500 bg-warn/5 border border-warn/20 rounded-lg p-2 leading-relaxed">
          💡 {t('history.hideTip')}
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
            {t('common.cancel')}
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
                {t('history.hideInProgress')}
              </>
            ) : (
              <>{t('history.hideConfirm')}</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 视频大预览 modal — 包含视频播放器 + 元数据 + 下载按钮 */
function VideoModal({ v, onClose }: { v: HistoryItem; onClose: () => void }) {
  const { t } = useT()
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
            title={t('common.close')}
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
                <span className="text-gray-500">{t('history.submittedAt')}</span>
                <span className="font-mono text-gray-300">{v.meta.submitted_at_iso}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gray-500">{t('history.finishedAt')}</span>
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
                {t('history.viewPrompt')}
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
              <span>⬇ {t('history.downloadVideo').replace('⬇ ', '')}</span>
              <span className="text-[10px] text-gray-600">{t('history.downloadMp4')}</span>
            </a>
            <a
              href={v.web_path}
              target="_blank"
              rel="noopener"
              className="flex-1 text-center text-xs text-gray-400 hover:text-accent transition py-2 px-3 rounded-lg bg-bg hover:bg-bg-hover flex flex-col items-center leading-tight"
            >
              <span>↗ {t('history.openNewTab').replace('↗ ', '')}</span>
              <span className="text-[10px] text-gray-600">{t('history.openInTab')}</span>
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
  const { t } = useT()
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
              <div className="text-xs">{t('history.noCover')}</div>
            </div>
          )}
          {/* 中央 ▶ 播放按钮 (无黑色遮罩 — cover 已够暗, 不需要再遮) */}
          <button
            type="button"
            onClick={startPlay}
            className="relative z-10 w-20 h-20 rounded-full bg-white/85 hover:bg-white text-black flex items-center justify-center text-3xl shadow-2xl hover:scale-105 transition"
            title={t('history.playVideo')}
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

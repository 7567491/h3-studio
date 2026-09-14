import { useState, useEffect, useMemo, useRef } from 'react'
import { api, type PromptItem, type CategoryStat, type Submission } from '../lib/api'
import { useActiveSub } from '../lib/activeSub'
import ProgressCard from '../components/ProgressCard'

/** ProgressCard 包装器 — 出现时自动滚动到视野内 (用户要求"在第一页最下面看到生成过程") */
function ProgressCardWithScroll(props: {
  sub: Submission
  promptText: string
  onReset?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const scrolledRef = useRef(false)
  useEffect(() => {
    if (scrolledRef.current) return
    // 给浏览器 1 帧让 ProgressCard 完成挂载 + animate-slide-up 起始
    requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      scrolledRef.current = true
    })
  }, [])
  return (
    <div ref={ref}>
      <ProgressCard {...props} />
    </div>
  )
}

// ========================================================== 参考图工具

// 短边最大像素 (ComfyUI ReferenceToVideo 节点内置下采样阈值)
const REF_MAX_SHORT_SIDE = 2048
// 第二轮缩放阈值: 极端源图(如 8K JPEG) 用 1600 短边进一步压缩
const REF_FALLBACK_SHORT_SIDE = 1600
// 目标大小: ≤ 800KB (远端 ComfyUI nginx client_max_body_size = 1m 硬约束, 留 200KB buffer 给 multipart boundary)
// 1MB 临界会让 JPEG 压到 1.05MB / 1.2MB 这种边缘值仍 413, 降到 800KB 更稳。
const REF_TARGET_BYTES = 800 * 1024
// 硬卡: 哪怕压到 1600px / q=0.55 仍 > 1MB → 拒绝, 避免上传死循环
const REF_HARD_LIMIT_BYTES = 1 * 1024 * 1024
// JPEG 质量阶梯 — 从高到低逐档降级, 直到 ≤ REF_TARGET_BYTES
// 0.92 起步 → 0.85 → 0.75 → 0.65 → 0.55 (5档足够覆盖 0.5MB ~ 20MB 源图)
const REF_QUALITY_TIERS = [0.92, 0.85, 0.75, 0.65, 0.55]

export type ProcessRefProgress = (msg: string) => void

/**
 * 加载文件 → 用 canvas 等比缩到短边 ≤ REF_MAX_SHORT_SIDE, 转 JPEG。
 * 如果压缩后仍 > REF_TARGET_BYTES (1MB),按 REF_QUALITY_TIERS 逐档降质量再压。
 * 全部档位失败 → 缩到 REF_FALLBACK_SHORT_SIDE 再走一遍阶梯。
 * 仍 > REF_HARD_LIMIT_BYTES → throw(前端硬卡)。
 *
 * 返回: { file: File (jpeg), origBytes, finalBytes, finalShortSide, finalQuality }
 */
async function processRefImage(
  file: File,
  onProgress?: ProcessRefProgress,
): Promise<{
  file: File
  origBytes: number
  finalBytes: number
  finalShortSide: number
  finalQuality: number
}> {
  onProgress?.(`解码 ${(file.size / 1024).toFixed(0)}KB`)
  // 1. 解码
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = () => reject(new Error('图片解码失败'))
    i.src = URL.createObjectURL(file)
  })
  const { width: w0, height: h0 } = img
  const short0 = Math.min(w0, h0)
  onProgress?.(`原图 ${w0}×${h0} (短边 ${short0}px)`)

  // 2. 画到 canvas (给定短边)
  const draw = (shortSide: number, quality: number): Promise<File> =>
    new Promise((resolve, reject) => {
      const scale = short0 > shortSide ? shortSide / short0 : 1
      const w = Math.round(w0 * scale)
      const h = Math.round(h0 * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('canvas 2d context 不可用'))
      ctx.drawImage(img, 0, 0, w, h)
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error('canvas 转 blob 失败'))
          resolve(new File([blob], 'ref.jpg', { type: 'image/jpeg', lastModified: Date.now() }))
        },
        'image/jpeg',
        quality,
      )
    })

  // 3. 第 1 轮: 短边 2048,按质量阶梯逐档降
  let processed = await draw(REF_MAX_SHORT_SIDE, REF_QUALITY_TIERS[0])
  let lastQuality = REF_QUALITY_TIERS[0]
  for (let i = 1; i < REF_QUALITY_TIERS.length && processed.size > REF_TARGET_BYTES; i++) {
    lastQuality = REF_QUALITY_TIERS[i]
    onProgress?.(`压缩 q=${lastQuality} → ${(processed.size / 1024).toFixed(0)}KB 仍 >1MB`)
    processed = await draw(REF_MAX_SHORT_SIDE, lastQuality)
  }

  // 4. 仍 > 1MB → 缩到 1600 短边再走一遭阶梯
  if (processed.size > REF_TARGET_BYTES) {
    onProgress?.(`缩到 ${REF_FALLBACK_SHORT_SIDE}px 短边重试`)
    processed = await draw(REF_FALLBACK_SHORT_SIDE, REF_QUALITY_TIERS[0])
    lastQuality = REF_QUALITY_TIERS[0]
    for (let i = 1; i < REF_QUALITY_TIERS.length && processed.size > REF_TARGET_BYTES; i++) {
      lastQuality = REF_QUALITY_TIERS[i]
      onProgress?.(`压缩 q=${lastQuality} → ${(processed.size / 1024).toFixed(0)}KB 仍 >1MB`)
      processed = await draw(REF_FALLBACK_SHORT_SIDE, lastQuality)
    }
  }

  if (processed.size > REF_HARD_LIMIT_BYTES) {
    throw new Error(
      `压缩后仍 ${(processed.size / 1024 / 1024).toFixed(1)}MB, ` +
        `超过 ${REF_HARD_LIMIT_BYTES / 1024 / 1024}MB 硬上限, 请用更小的源图`,
    )
  }

  URL.revokeObjectURL(img.src)
  onProgress?.(
    `✓ ${(file.size / 1024 / 1024).toFixed(2)}MB → ${(processed.size / 1024).toFixed(0)}KB (q=${lastQuality})`,
  )

  return {
    file: processed,
    origBytes: file.size,
    finalBytes: processed.size,
    finalShortSide: Math.min(
      Math.round(w0 * (processed.size > REF_TARGET_BYTES ? REF_FALLBACK_SHORT_SIDE / short0 : REF_MAX_SHORT_SIDE / short0)),
      short0,
    ),
    finalQuality: lastQuality,
  }
}

export default function GenerateTab() {
  const [promptText, setPromptText] = useState('')
  const [duration, setDuration] = useState(5)
  // 固定 480p: 720p / 1080p 在 远端 ComfyUI 上从未真跑过样本 (history 全 832x480),
  // 1080p 实际耗时 25 分钟 (vs 480p 的 2-3 分钟), GPU/显存压力倍增。
  // 先收敛在 480p, 等实测有数据再考虑开放更多选项。
  const RESOLUTION = '480p' as const
  const [submitting, setSubmitting] = useState(false)
  // activeSub 改成从 context 拿 (跨 Tab 共享 — 切到 QueueTab 也能看到完整进度卡)
  const { sub: activeSub, setActiveSub } = useActiveSub()
  const [promptErr, setPromptErr] = useState<string | null>(null)

  // 参考图状态
  // refImageDataURL: <canvas> dataURL 用于本地预览 (不发送)
  // refImageFilename: 显示文件名 (不发送, 仅 UI 反馈)
  // refImageUploading: 上传中 spinner
  // refImageError: 校验/上传失败提示
  // refImageCompression: 压缩进度文字 (e.g. "3.2MB → 850KB q=0.85"), 上传完成后显示最终比例
  const [refImageDataURL, setRefImageDataURL] = useState<string | null>(null)
  const [refImageFilename, setRefImageFilename] = useState<string | null>(null)
  const [refImageUploading, setRefImageUploading] = useState(false)
  const [refImageError, setRefImageError] = useState<string | null>(null)
  const [refImageCompression, setRefImageCompression] = useState<string | null>(null)

  const [refImageServerPath, setRefImageServerPath] = useState<string | null>(null)

  // === Prompt 扩写状态 (MiniMax H3 Ref2VA/T2VA 模板) ===
  const [expanding, setExpanding] = useState(false)
  const [expandError, setExpandError] = useState<string | null>(null)
  const [expandedStructured, setExpandedStructured] = useState<Record<string, string> | null>(null)
  const [expandedMode, setExpandedMode] = useState<'T2VA' | 'Ref2VA' | null>(null)
  const [imageDescription, setImageDescription] = useState<string | null>(null)
  const [showStructured, setShowStructured] = useState(false)
  // 保存扩写前的 prompt, 用户可一键还原
  const [preExpandPrompt, setPreExpandPrompt] = useState<string | null>(null)
  // 暂存扩写时需要的原图 File (扩写用, 不是上传到 远端 ComfyUI 用的那个)
  const [pendingExpandFile, setPendingExpandFile] = useState<File | null>(null)

  // 库选择
  const [categories, setCategories] = useState<CategoryStat[]>([])
  const [selectedCat, setSelectedCat] = useState('all')
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [loadingPrompts, setLoadingPrompts] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [showLibrary, setShowLibrary] = useState(false)

  // 加载分类
  useEffect(() => {
    api.promptCategories().then((r) => setCategories(r.categories)).catch(console.error)
  }, [])

  // 加载 prompts (按 category 切换)
  useEffect(() => {
    setLoadingPrompts(true)
    api.prompts('', selectedCat, 100)
      .then((r) => setPrompts(r.results))
      .catch(console.error)
      .finally(() => setLoadingPrompts(false))
  }, [selectedCat])

  // 搜索过滤(纯前端)
  const filteredPrompts = useMemo(() => {
    if (!searchQ) return prompts
    const q = searchQ.toLowerCase()
    return prompts.filter(p => p.title.toLowerCase().includes(q))
  }, [prompts, searchQ])

  const pickPrompt = (p: PromptItem) => {
    api.promptDetail(p.slug).then((d) => {
      setPromptText(d.prompt)
      setShowLibrary(false)
      const num = parseInt(p.duration)
      if (num >= 1 && num <= 30) setDuration(num)
    })
  }

  // 参考图选择 → Canvas 缩放 → 上传到 远端 ComfyUI → 保存 server path 给 submit 用
  // 上传成功后,自动在 prompt 开头 prepend "<Picture 1> "(仅一次)
  const REF_TAG = '<Picture 1> '
  const handleRefFile = async (file: File) => {
    setRefImageError(null)
    if (!file.type.startsWith('image/')) {
      setRefImageError('不是图片文件')
      return
    }
    setRefImageUploading(true)
    setRefImageFilename(file.name)
    setRefImageDataURL(URL.createObjectURL(file))
    setRefImageServerPath(null)
    // 压缩进度提示 (e.g. "3.2MB → 850KB q=0.85"), 显示在 chip 上
    setRefImageCompression(`压缩 ${(file.size / 1024 / 1024).toFixed(2)}MB → ?`)
    try {
      const result = await processRefImage(file, (msg) =>
        setRefImageCompression(msg),
      )
      const processed = result.file
      const fmtBytes = (b: number) =>
        b / 1024 / 1024 >= 1
          ? (b / 1024 / 1024).toFixed(2) + 'MB'
          : (b / 1024).toFixed(0) + 'KB'
      setRefImageCompression(
        `${fmtBytes(result.origBytes)} → ${fmtBytes(result.finalBytes)} q=${result.finalQuality}`,
      )
      const r = await api.uploadRef(processed)
      setRefImageServerPath(r.ref_image)
      // 保存 resize 后的 File, 供 handleExpand 用 (避免扩写时再传原图)
      setPendingExpandFile(processed)
      // 自动 prepend <Picture 1> 标签 (若还没 prepend 过)
      setPromptText((prev) => (prev.startsWith(REF_TAG) ? prev : REF_TAG + prev))
    } catch (e: any) {
      setRefImageError(`参考图上传失败: ${e.message ?? '未知错误'}`)
      setRefImageServerPath(null)
      setRefImageDataURL(null)
      setRefImageFilename(null)
      setRefImageCompression(null)
    } finally {
      setRefImageUploading(false)
    }
  }

  // 移除 ref 图: 清掉 state + 从 prompt 移除自动 prepend 的 <Picture 1> 标签
  const handleRemoveRef = () => {
    setRefImageDataURL(null)
    setRefImageFilename(null)
    setRefImageServerPath(null)
    setRefImageError(null)
    setPendingExpandFile(null)
    setPromptText((prev) => prev.startsWith(REF_TAG) ? prev.slice(REF_TAG.length) : prev)
  }

  const handleExpand = async () => {
    setExpandError(null)
    const p = promptText.trim()
    if (!p) {
      setExpandError('请先输入 prompt')
      return
    }
    setExpanding(true)
    // 暂存原 prompt 用于"还原"
    setPreExpandPrompt(p)
    try {
      // 用已 resize 过的 ref 图给扩写 (避免 nginx 50M 上限, 也避免给 vision 模型传原图)
      // pendingExpandFile 由 handleRefFile 在 resize 成功后写入
      const refFile = pendingExpandFile
      const result = await api.expandPrompt(p, duration, refFile)
      setExpandedStructured(result.structured)
      setExpandedMode(result.mode)
      setImageDescription(result.image_description)
      setPromptText(result.prompt)
      setShowStructured(true)
      if (result.vision_error) {
        setExpandError(`参考图识别失败: ${result.vision_error}, 已用 T2VA 降级`)
      }
      if (result.warning) {
        setExpandError(result.warning)
      }
    } catch (e: any) {
      setExpandError(`扩写失败: ${e?.message || e}`)
    } finally {
      setExpanding(false)
    }
  }

  const handleRestorePreExpand = () => {
    if (preExpandPrompt !== null) {
      setPromptText(preExpandPrompt)
      setPreExpandPrompt(null)
    }
    setShowStructured(false)
    setExpandedStructured(null)
  }

  const handleSubmit = async () => {
    setPromptErr(null)
    if (!promptText.trim()) {
      setPromptErr('请输入 prompt')
      return
    }
    // 有参考图但还没上传成功 → 不允许提交
    if (refImageDataURL && !refImageServerPath) {
      setPromptErr('参考图还没上传完成')
      return
    }
    setSubmitting(true)
    try {
      const sub = await api.submit({
        prompt_text: promptText.trim(),
        duration_s: duration,
        resolution: RESOLUTION,
        ref_image: refImageServerPath,
      })
      // App 层 Context: setActiveSub 内部会 subscribeProgress (一次连接多 Tab 共享)
      setActiveSub(sub, promptText.trim())
    } catch (e: any) {
      setPromptErr(e.message ?? '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-5 animate-slide-up">
      {/* 标题 — 苹果范儿：简洁一行 */}
      <h2 className="text-2xl font-semibold text-white tracking-tight">
        视频生成
      </h2>

      {/* Prompt 输入框 */}
      <div className="bg-bg-card rounded-2xl p-4 space-y-3">
        <textarea
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl + Enter: 触发扩写 (AI 增强 prompt, 再决定提交)
            // Cmd/Ctrl + Shift + Enter: 直接生成
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              if (e.shiftKey) {
                handleSubmit()
              } else {
                handleExpand()
              }
            }
          }}
          placeholder="输入 Input Prompt"
          rows={7}
          className="w-full bg-bg rounded-lg p-3 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-accent/50 placeholder:text-gray-600 min-h-[140px] max-h-96"
        />

        {/* 控制行 1 — 配置 chips (时长 + 参考图 + 库) — 统一风格 */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* 时长选择 (chip 样式) — select 自身就是控件,不要用 absolute 覆盖 */}
          <select
            value={duration}
            onChange={(e) => setDuration(parseInt(e.target.value))}
            className="chip-base appearance-none cursor-pointer pr-7 bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 12 12%22><path fill=%22%23999%22 d=%22M6 9L1 4h10z%22/></svg>')] bg-no-repeat bg-[right_8px_center]"
          >
            {[5, 10, 15].map(s => <option key={s} value={s} className="bg-bg-card text-gray-300">{s}s</option>)}
          </select>

          {/* 参考图 chip — 无图 = 上传; 有图 = 已上传 + 移除 */}
          {!refImageDataURL ? (
            <label className="chip-base cursor-pointer" title="上传参考图 (Ref2VA 模式)">
              <span>📎 参考 Ref</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleRefFile(f)
                  e.target.value = ''
                }}
              />
            </label>
          ) : (
            <div className="flex items-center gap-1">
              <span
                className={`chip-base max-w-[220px] truncate ${
                  refImageError
                    ? '!border-err/40 !text-err !bg-err/10'
                    : refImageUploading
                    ? ''
                    : '!border-accent/40 !text-accent !bg-accent/10'
                }`}
                title={
                  refImageError
                    ? String(refImageError)
                    : (refImageCompression ?? refImageFilename ?? '')
                }
              >
                {refImageError ? (
                  <>⚠ 失败</>
                ) : refImageUploading ? (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                    {refImageCompression ?? '上传中'}
                  </>
                ) : (
                  <>
                    ✓ {refImageCompression ?? '参考图'}
                  </>
                )}
              </span>
              <button
                onClick={handleRemoveRef}
                className="chip-base !px-2"
                title="移除参考图"
              >
                ✕
              </button>
            </div>
          )}

          {/* 库选择 chip */}
          <button
            onClick={() => setShowLibrary(s => !s)}
            title="从库选 prompt"
            className={`chip-base ${showLibrary ? '!border-accent/40 !text-accent !bg-accent/10' : ''}`}
          >
            <span>📚 Prompt 库</span>
          </button>
        </div>

        {/* 控制行 2 — 操作 (库提示 + 扩写 + 生成 GO) — Primary 在最右 */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* 库展开时的提示 (空格, 让扩写/生成 GO 视觉对齐) */}
          {showLibrary && (
            <span className="text-[10px] text-gray-500">↓ 从库里选 prompt</span>
          )}

          {/* 把 actions 推到右边 (空状态时不留白) */}
          <div className="ml-auto" />

          {/* 扩写按钮 — chip 样式, 已扩写时高亮 (按钮文字保持 "扩写", 状态靠 accent 色提示) */}
          <button
            onClick={handleExpand}
            disabled={expanding || !promptText.trim()}
            className={`chip-base disabled:opacity-50 ${
              expandedMode ? '!border-accent/40 !text-accent !bg-accent/10' : ''
            }`}
            title={refImageDataURL
              ? '使用 H3 Ref2VA 6 段模板扩写 — 8-15 秒'
              : '使用 H3 T2VA 3 段模板扩写 — 5-10 秒'}
          >
            {expanding ? (
              <>
                <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                扩写中…
              </>
            ) : (
              <>✨ 扩写</>
            )}
          </button>

          {/* 主 CTA: 生成 GO — 同 chip 风格但 accent 实心 + 略大 */}
          <button
            onClick={handleSubmit}
            disabled={submitting || !promptText.trim()}
            className="inline-flex items-center gap-1.5 bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:bg-bg-card disabled:text-gray-500 text-white font-medium px-4 py-1.5 rounded-lg text-sm shadow-md shadow-accent/30 disabled:shadow-none disabled:cursor-not-allowed transition"
          >
            <span>🚀</span>
            <span>{submitting ? '提交中…' : '生成 GO'}</span>
          </button>
        </div>

        {/* 扩写错误/降级提示 */}
        {expandError && (
          <p className="text-err text-xs">⚠ {expandError}</p>
        )}

        {/* 查看 prompt 详情按钮 (扩写后才出现, 放控制行外) */}
        {expandedStructured && !expanding && (
          <button
            onClick={() => setShowStructured(s => !s)}
            className="text-xs text-accent hover:text-accent-glow transition flex items-center gap-1"
          >
            {showStructured ? '收起 prompt 结构 ▲' : '📋 查看 prompt 详情 ▼'}
          </button>
        )}

        {promptErr && <p className="text-err text-sm">⚠ {promptErr}</p>}
      </div>

      {/* 结构化 Prompt 详情面板 (扩写后展开) */}
      {showStructured && expandedStructured && (
        <div className="bg-bg-card rounded-2xl p-4 space-y-3 animate-slide-up">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-accent font-medium">
              📋 Prompt 结构详情
            </span>
            <span className="text-xs text-gray-500">
              {expandedMode === 'Ref2VA' ? 'Ref2VA · 6 段' : 'T2VA · 3 段'}
              · 已自动写入上方 textarea
            </span>
            {imageDescription && (
              <span className="text-[10px] text-gray-600 ml-auto" title={imageDescription}>
                🖼 图识别: {imageDescription.slice(0, 60)}{imageDescription.length > 60 ? '...' : ''}
              </span>
            )}
          </div>

          {/* 按段渲染 */}
          {Object.entries(expandedStructured).map(([name, body]) => (
            <div key={name} className="bg-bg rounded-lg p-3">
              <div className="text-[11px] text-accent uppercase tracking-wide mb-1.5 font-medium">
                {name}
              </div>
              <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">
                {body}
              </pre>
            </div>
          ))}

          <p className="text-[10px] text-gray-600">
            💡 这些段已合并写入上方 textarea, 直接生成即可, 也可手动修改后再生成
          </p>
        </div>
      )}

      {/* 库选择面板 */}
      {showLibrary && (
        <div className="bg-bg-card rounded-2xl p-4 space-y-3 animate-slide-up">
          <div className="flex items-center gap-2">
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="搜索库内 prompt 标题... / Search prompts"
              className="flex-1 bg-bg rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
            <span className="text-xs text-gray-500">{filteredPrompts.length}</span>
          </div>

          {/* 分类 chips */}
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
            <button
              onClick={() => setSelectedCat('all')}
              className={`whitespace-nowrap px-3 py-1 rounded-full text-xs transition ${
                selectedCat === 'all' ? 'bg-accent text-white' : 'bg-bg text-gray-400'
              }`}
            >
              All
            </button>
            {categories.map(c => (
              <button
                key={c.name}
                onClick={() => setSelectedCat(c.name)}
                className={`whitespace-nowrap px-3 py-1 rounded-full text-xs transition ${
                  selectedCat === c.name ? 'bg-accent text-white' : 'bg-bg text-gray-400'
                }`}
              >
                {c.name} <span className="opacity-60">{c.count}</span>
              </button>
            ))}
          </div>

          {/* Prompt 列表 */}
          <div className="max-h-80 overflow-y-auto space-y-1">
            {loadingPrompts ? (
              <div className="text-center text-gray-500 text-sm py-4">加载中…</div>
            ) : filteredPrompts.length === 0 ? (
              <div className="text-center text-gray-500 text-sm py-4">无匹配</div>
            ) : filteredPrompts.map(p => (
              <button
                key={p.slug}
                onClick={() => pickPrompt(p)}
                className="w-full text-left p-2.5 rounded-lg hover:bg-bg-hover transition flex items-start gap-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{p.title}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{p.category} · {p.duration}</div>
                </div>
                <span className="text-xs text-gray-600 mt-1">→</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 进行中的任务 — 出现在 Tab 末尾, 自动滚动到视野 */}
      {activeSub && <ProgressCardWithScroll
        sub={activeSub}
        promptText={promptText}
        onReset={() => {
          setActiveSub(null)
          setPromptText('')
          window.scrollTo({ top: 0, behavior: 'smooth' })
        }}
      />}
    </div>
  )
}

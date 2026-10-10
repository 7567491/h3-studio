import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { ActiveSubContext, type ActiveSubContextValue } from './lib/activeSub'
import { subscribeProgress } from './lib/ws'
import { useT } from './lib/i18n'
import type { Submission } from './lib/api'

type Tab = 'generate' | 'queue' | 'history'

// 底部 Tab Bar 的 icon (emoji 不走 i18n, 保持常量)
// Bug fix 2026-10-10: 之前用 Object.entries(t('tabs')) 动态遍历,
// 在 authed=true 路径触发 "Cannot read properties of undefined (reading 'icon')"。
// 原因: i18n 字典的 tabs 是任意键对象, 与这里 Record<Tab, ...> 的字面量类型没有编译期校验,
//   Object.entries 跑出来的 key 不一定在 tabsKeys 里。改为: tab 顺序/key 用 TS 硬编码,
//   文本走 i18n(动态), icon 走常量 — 三层互不干扰, TS 编译期 + runtime 都安全。
const TAB_ORDER: readonly Tab[] = ['generate', 'queue', 'history'] as const
const TAB_ICONS: Record<Tab, string> = {
  generate: '✨',
  queue: '⚡',
  history: '🎬',
}

export default function App() {
  const [tab, setTab] = useState<Tab>('generate')
  const [authed, setAuthed] = useState<boolean>(false)
  const { t, lang, toggle } = useT()

  // === 跨 Tab 共享的活跃 submission ===
  // App 层持 state, 通过 context 暴露给所有 Tab
  // WS 订阅放 App 层, 一次连接所有 Tab 共享进度事件
  const [sub, setSub] = useState<Submission | null>(null)
  const [promptText, setPromptText] = useState('')
  const wsUnsubscribeRef = useRef<(() => void) | null>(null)

  const setActiveSub = useCallback((s: Submission | null, p?: string) => {
    // 关掉旧订阅
    if (wsUnsubscribeRef.current) {
      wsUnsubscribeRef.current()
      wsUnsubscribeRef.current = null
    }
    setSub(s)
    if (p !== undefined) setPromptText(p)
    if (s) {
      // 立即推一次 snapshot (后端 WS 第一个消息就是 snapshot)
      setSub({ ...s })
      // 开新订阅
      wsUnsubscribeRef.current = subscribeProgress(s.submission_id, (evt) => {
        if (evt.type === 'snapshot') {
          setSub(evt.data as Submission)
        } else if (evt.type === 'progress') {
          setSub((prev) => prev ? {
            ...prev,
            status: 'running',
            progress: evt.percent,
            progress_step: evt.value,
            progress_max: evt.max,
          } : prev)
        } else if (evt.type === 'done') {
          setSub((prev) => prev ? {
            ...prev,
            status: 'done',
            progress: 1,
            output_files: evt.files ?? [],
          } : prev)
        } else if (evt.type === 'error') {
          setSub((prev) => prev ? { ...prev, status: 'error', error: evt.error } : prev)
        } else if (evt.type === 'node_output') {
          // 节点产出 (一般是 SaveVideo 节点) - files 累加
          setSub((prev) => prev ? {
            ...prev,
            output_files: [...(prev.output_files ?? []), ...(evt.files ?? [])],
          } : prev)
        }
      })
    }
  }, [])

  // 卸载时关掉 WS
  useEffect(() => {
    return () => {
      if (wsUnsubscribeRef.current) {
        wsUnsubscribeRef.current()
        wsUnsubscribeRef.current = null
      }
    }
  }, [])

  const activeSubValue = useMemo<ActiveSubContextValue>(
    () => ({ sub, promptText, setActiveSub }),
    [sub, promptText, setActiveSub],
  )

  // 启动时检查 localStorage 是否有 hash - 决定显示 PassGate 还是主界面
  useEffect(() => {
    const saved = localStorage.getItem('h3_pass_hash')
    if (saved && /^[a-f0-9]{64}$/.test(saved)) {
      // 静默验证 hash 是否还有效(后端可能改了口令)
      fetch('/api/auth/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass_hash: saved }),
      })
        .then(r => {
          if (r.ok) setAuthed(true)
          else localStorage.removeItem('h3_pass_hash')
        })
        .catch(() => {
          // 网络错误时保守策略:不自动进,让用户重试
          // 但不清 localStorage,可能只是临时断网
        })
    }
  }, [])

  // 未通过口令 → 全屏 PassGate
  if (!authed) {
    return <PassGate onSuccess={() => setAuthed(true)} />
  }

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background:
          'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99,102,241,0.08), transparent 60%), radial-gradient(ellipse 60% 50% at 90% 100%, rgba(168,85,247,0.06), transparent 50%)',
      }}
    >
      {/* 顶部 Header */}
      <header className="sticky top-0 z-30 bg-bg/95 backdrop-blur border-b border-white/5">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img
              src="./akamai-logo.png"
              alt="Akamai"
              className="h-9 w-auto"
            />
            <div>
              <h1 className="text-base font-semibold leading-none">{t('header.title')}</h1>
              <p className="text-xs text-gray-500 mt-0.5">{t('header.subtitle')}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* 语言切换按钮 — 中 / EN,显示当前语言,click 切换 */}
            <button
              type="button"
              onClick={toggle}
              title="Switch language / 切换语言"
              className="text-[10px] font-mono px-2 py-1 rounded-full border border-white/10 text-gray-400 hover:text-accent hover:border-accent/40 transition"
              aria-label="Switch language"
            >
              <span className={lang === 'zh' ? 'text-accent font-semibold' : ''}>中</span>
              <span className="mx-1 text-gray-600">/</span>
              <span className={lang === 'en' ? 'text-accent font-semibold' : ''}>EN</span>
            </button>
            <ComfyHealthBadge />
          </div>
        </div>
      </header>

      {/* 主内容 */}
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-4 pb-24">
        <ActiveSubContext.Provider value={activeSubValue}>
          {tab === 'generate' && <GenerateTab />}
          {tab === 'queue' && <QueueTab />}
          {tab === 'history' && <HistoryTab />}
        </ActiveSubContext.Provider>

        {/* 版权页脚 — 所有 Tab 都共享, 跟随 main 内容自然滚到底部 */}
        <footer className="mt-12 pt-4 border-t border-white/5 text-center text-[10px] text-gray-500 leading-relaxed">
          <div className="text-gray-400">{t('footer.copyZh')}</div>
          <div className="mt-1 text-gray-600">{t('footer.copyEn')}</div>
        </footer>
      </main>

      {/* 底部 Tab Bar — 移动端原生 feel */}
      {/* 中文主标签 + 英文小字副标签,方便英语用户快速识别 */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 bg-bg/95 backdrop-blur border-t border-white/5 safe-area-inset-bottom">
        <div className="max-w-3xl mx-auto grid grid-cols-3">
          {TAB_ORDER.map((id) => {
            const active = tab === id
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`relative py-2.5 flex flex-col items-center gap-0 text-xs transition ${
                  active
                    ? 'text-accent'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {active && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-accent rounded-b" />
                )}
                <span className={`text-lg leading-none transition-transform ${active ? 'scale-110' : ''}`}>{TAB_ICONS[id]}</span>
                <span className={`font-medium leading-tight mt-0.5 ${active ? 'font-semibold' : ''}`}>{t(`tabs.${id}.main`)}</span>
                <span className={`text-[10px] leading-tight ${
                  active ? 'text-accent/70' : 'text-gray-600'
                }`}>{t(`tabs.${id}.sub`)}</span>
              </button>
            )
          })}
        </div>
      </nav>
    </div>
  )
}

// ========================================== ComfyUI 健康 badge
// 2026-09-15 Jack 反馈: 顶部 ComfyHealthBadge 进度条/数字必须一直显示,
// 不能因为 ComfyUI 挂了就只剩 "离线" 文字。
//
// 改造: VRAM 数据从 /api/comfyui/status 改为 /api/gpu/processes (走 SSH nvidia-smi),
//       这条路完全独立于 ComfyUI,RTX 活着就能拿到数据。
// ComfyUI 健康度(绿色 = 可用 / 灰 = 不可用)独立显示,只影响圆点颜色。
function ComfyHealthBadge() {
  const { t } = useT()
  const [comfyOk, setComfyOk] = useState<boolean | null>(null)  // null=检测中
  const [vramUsed, setVramUsed] = useState<number | null>(null)
  const [vramTotal, setVramTotal] = useState<number | null>(null)
  const [gpuName, setGpuName] = useState<string | null>(null)

  const check = useCallback(async () => {
    // 1) VRAM 真实数据 — 走 SSH nvidia-smi (不受 ComfyUI 影响)
    try {
      const r = await fetch('/api/gpu/processes')
      const d = await r.json()
      if (d?.gpu) {
        setVramUsed(d.gpu.memory_used_gb ?? null)
        setVramTotal(d.gpu.memory_total_gb ?? null)
        setGpuName(d.gpu.name ?? null)
      }
    } catch { /* silent — 保持上次数据 */ }

    // 2) ComfyUI 健康度 — 单独探测
    try {
      const r = await fetch('/api/comfyui/status')
      const d = await r.json()
      setComfyOk(d?.ok === true)
    } catch {
      setComfyOk(false)
    }
  }, [])

  useEffect(() => {
    check()
    const t = setInterval(check, 15000)
    return () => clearInterval(t)
  }, [check])

  // 简化 GPU 名字: "NVIDIA RTX PRO 6000 Blackwell..." → "RTX PRO 6000..."
  const shortName = gpuName?.includes('RTX') ? gpuName.split('NVIDIA ')[1]?.split(' :')[0] || gpuName : gpuName

  // 进度条数据: 独立于 ComfyUI,只要 RTX 活着就一直有
  const showBar = vramUsed !== null && vramTotal !== null
  const pct = vramUsed !== null && vramTotal ? (vramUsed / vramTotal) * 100 : null
  // < 70% 绿, 70-90% 黄, > 90% 红
  const colorBar = pct === null ? 'bg-gray-500'
    : pct < 70 ? 'bg-ok'
    : pct < 90 ? 'bg-warn'
    : 'bg-err animate-pulse'

  // 圆点: ComfyUI 可用 + 显存健康 → 绿; ComfyUI 不可用 → 灰 (但条还显示); 显存黄/红 → 黄/红
  const dotColor = comfyOk === null ? 'bg-gray-500 animate-pulse'
    : comfyOk && pct !== null && pct < 90 ? 'bg-ok'
    : comfyOk ? 'bg-warn animate-pulse'
    : 'bg-gray-600'  // ComfyUI 不可用 — 圆点变灰但条不消失

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-2 h-2 rounded-full ${dotColor}`} />
      {showBar ? (
        <>
          <span className="text-gray-500 hidden md:inline" title={gpuName ?? ''}>
            {shortName?.split(' ').slice(0, 3).join(' ')}
          </span>
          {/* 进度条 (40px 宽) — 永远显示 (Jack 2026-09-15) */}
          <div className="flex items-center gap-1.5">
            <div className="w-10 h-1.5 bg-bg rounded-full overflow-hidden">
              <div
                className={`h-full ${colorBar} transition-all`}
                style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
              />
            </div>
            <span className="font-mono text-gray-400 tabular-nums">{Math.round(pct ?? 0)}%</span>
          </div>
          {/* 详细数字 */}
          <span className="font-mono text-gray-500 hidden lg:inline tabular-nums">
            {vramUsed!.toFixed(0)}G / {vramTotal!.toFixed(0)}G {t('health.vramUsed')}
          </span>
          {/* ComfyUI 状态 — 不可用时显文字,可用时静默 (避免噪音) */}
          {comfyOk === false && (
            <span className="text-[10px] text-gray-500 hidden sm:inline" title="ComfyUI 不可用, 但 GPU/进程数据走 SSH 仍可用">
              · {t('health.comfyOffline')}
            </span>
          )}
        </>
      ) : comfyOk === false ? (
        <span className="text-err">{t('common.offline')}</span>
      ) : (
        <span className="text-gray-500">{t('common.detecting')}</span>
      )}
    </div>
  )
}

// ========================================== Generate Tab
import GenerateTab from './tabs/GenerateTab'
import QueueTab from './tabs/QueueTab'
import HistoryTab from './tabs/HistoryTab'

// ========================================== PassGate
import PassGate from './components/PassGate'

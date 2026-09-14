/**
 * PassGate - 首次访问的口令输入门
 *
 * 流程:
 * 1. 用户首次访问,localStorage 无 h3_pass_hash → 显示 PassGate
 * 2. 用户输入口令 → 客户端 sha256 → POST /api/auth/check
 * 3. 后端 ok → localStorage.setItem('h3_pass_hash', hash) → 显示主界面
 * 4. 之后刷新页面 → useEffect 读 localStorage → 已存在 → 直接进
 *
 * 安全设计:
 * - 口令永远不出现在网络/日志里(只传 sha256)
 * - localStorage 存 hash 而非明文
 * - 后端比对 hash,前端不知道也不关心原口令(只有用户知道)
 */

import { useState, useEffect } from 'react'

async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

const STORAGE_KEY = 'h3_pass_hash'

interface PassGateProps {
  onSuccess: () => void
}

export default function PassGate({ onSuccess }: PassGateProps) {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  // 启动时如果 localStorage 已有 hash,先静默校验(可能口令已被改过)
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && /^[a-f0-9]{64}$/.test(saved)) {
      verify(saved)
    }
  }, [])

  async function verify(hash: string) {
    setChecking(true)
    setError(null)
    try {
      const r = await fetch('/api/auth/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass_hash: hash }),
      })
      if (r.ok) {
        localStorage.setItem(STORAGE_KEY, hash)
        onSuccess()
      } else {
        localStorage.removeItem(STORAGE_KEY)
        setError('口令已变更,请重新输入')
      }
    } catch (e: any) {
      setError(`网络错误: ${e.message}`)
    } finally {
      setChecking(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!input.trim()) {
      setError('请输入口令')
      return
    }
    const hash = await sha256(input)
    // 用完立即清空 input,避免明文留在 React state 里
    setInput('')
    await verify(hash)
  }

  function handleForgot() {
    if (confirm('清除本地记住的口令?下次需要重新输入。')) {
      localStorage.removeItem(STORAGE_KEY)
      setError(null)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-bg">
      <div className="w-full max-w-md bg-bg-card rounded-3xl p-8 space-y-6 shadow-2xl border border-white/5">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent to-purple-600 flex items-center justify-center font-bold text-2xl shadow-lg shadow-accent/20">
            H3
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold">H3 Video Studio</h1>
            <p className="text-xs text-gray-500 mt-1">输入访问口令</p>
            <p className="text-[10px] text-gray-600 mt-0.5">Enter access password</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="访问口令 / Password"
            autoFocus
            disabled={checking}
            className="w-full bg-bg rounded-xl px-4 py-3 text-center text-base font-mono focus:outline-none focus:ring-2 focus:ring-accent/50 border border-white/10 disabled:opacity-50"
          />

          <button
            type="submit"
            disabled={checking || !input.trim()}
            className="w-full bg-accent hover:bg-accent-glow disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium py-2.5 rounded-xl transition flex flex-col items-center leading-tight"
          >
            <span>{checking ? '验证中…' : '进入 →'}</span>
            <span className="text-[10px] font-normal opacity-70">
              {checking ? 'Verifying…' : 'Enter'}
            </span>
          </button>

          {error && (
            <p className="text-err text-sm text-center">⚠ {error}</p>
          )}
        </form>

        <div className="pt-2 border-t border-white/5 text-center">
          <button
            type="button"
            onClick={handleForgot}
            className="text-xs text-gray-500 hover:text-gray-300 transition flex flex-col items-center w-full leading-tight"
          >
            <span>忘记口令?清除本地记录</span>
            <span className="text-[10px] text-gray-600">Forgot? Clear saved password</span>
          </button>
        </div>

        {/* 版权声明 — 用户首次进来就能看到 */}
        <div className="pt-3 border-t border-white/5 text-center text-[10px] text-gray-500 leading-relaxed">
          <div className="text-gray-400">
            🔒 仅限个人学习测试使用 · 禁止传播、转发、二次分发、商业使用
          </div>
          <div className="mt-1 text-gray-600">
            For personal study and testing only · No redistribution, republishing, or commercial use
          </div>
        </div>
      </div>
    </div>
  )
}

/** 轻量 i18n — Provider + useT hook + localStorage 持久化
 *
 * 设计原则:
 * - 0 依赖: 自建, 不用 react-i18next
 * - 默认 zh (项目原 UI 主语言)
 * - localStorage key 'h3_lang' 记忆用户选择
 * - 嵌套字典 + fallback: 当前语言缺 key 时回落到 zh, 再缺时回落到 key 名
 * - useT() 返回 (t: (path, vars?) => string, lang: 'zh' | 'en', setLang: (l) => void)
 *
 * t() 用点分路径: t('generate.go'), t('progress.steps.3') (数组索引也行).
 * 插值用 {{var}} 模板, 例: t('progress.remaining', { n: 42 }) → '约 42s'
 *
 * 配套字典: src/locales/zh.ts + src/locales/en.ts
 */

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { zh } from '../locales/zh'
import { en } from '../locales/en'

export type Lang = 'zh' | 'en'
// 字典类型用宽口径, 避免两语言字面量数组/对象结构微差导致 TS 不兼容
type Dict = Record<string, any>

const STORAGE_KEY = 'h3_lang'
const DICTS: Record<Lang, Dict> = { zh, en }

interface I18nContextValue {
  lang: Lang
  setLang: (l: Lang) => void
  toggle: () => void
  // 返回 string, 内部走 Record<string, any> 已自动转
  t: (path: string, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'en',
  setLang: () => {},
  toggle: () => {},
  t: (p) => p,
})

/** 从嵌套字典按点分路径取值, 数组/对象都行 */
function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined
    // 数组索引支持: 'progress.steps.3' → steps[3]
    const idx = Number(key)
    if (Array.isArray(acc) && Number.isInteger(idx) && idx >= 0) return acc[idx]
    return acc[key]
  }, obj)
}

/** {{var}} 模板替换 */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k]
    return v == null ? `{{${k}}}` : String(v)
  })
}

export function LangProvider({ children }: { children: ReactNode }) {
  // 初始读 localStorage (SSR / 首屏渲染前 hydration 一致性 → 默认 en, useEffect 同步)
  // Bug fix 2026-10-10: 默认改 en (之前默认 zh, 但 Jack 偏好英文).
  const [lang, setLangState] = useState<Lang>('en')

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') {
      setLangState(saved)
    }
  }, [])

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    localStorage.setItem(STORAGE_KEY, l)
    // 同步 html lang 属性 (浏览器翻译/无障碍)
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
  }, [])

  const toggle = useCallback(() => {
    setLang(lang === 'en' ? 'zh' : 'en')
  }, [lang, setLang])

  const t = useCallback(
    (path: string, vars?: Record<string, string | number>): string => {
      // 当前语言 → 回落 zh → 回落 key 名
      const primary = getByPath(DICTS[lang], path)
      if (primary != null) return interpolate(String(primary), vars)
      if (lang !== 'zh') {
        const fallback = getByPath(DICTS.zh, path)
        if (fallback != null) return interpolate(String(fallback), vars)
      }
      // 开发期提醒 (控制台, 不打扰生产)
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(`[i18n] missing key: ${path}`)
      }
      return path
    },
    [lang],
  )

  // 首次挂载时同步 html lang
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  return (
    <I18nContext.Provider value={{ lang, setLang, toggle, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useT() {
  return useContext(I18nContext)
}
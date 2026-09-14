/** 跨 Tab 共享的当前活跃 submission 状态
 *
 * 需求: 用户在 GenerateTab 提交后, 切到 QueueTab 也要能看到完整进度卡 + 视频预览.
 *      切到 HistoryTab 也一样.
 *
 * 设计: 用 React Context 包装 submission + WS 订阅句柄
 *  - App.tsx 创建 context provider, 在顶层 subscribeProgress (一次订阅, 多 Tab 复用)
 *  - GenerateTab 提交时调 setActiveSub(sub) 触发 provider 开始订阅
 *  - QueueTab / HistoryTab 通过 useActiveSub() 读
 *  - onReset() 调 setActiveSub(null) 关闭订阅
 */
import { createContext, useContext } from 'react'
import type { Submission } from './api'

export interface ActiveSubContextValue {
  sub: Submission | null
  // 最近一次 generate 时用户输入的 prompt (用于 progress 卡展示)
  promptText: string
  // 设置新 sub (GenerateTab 提交成功后调)
  setActiveSub: (sub: Submission | null, promptText?: string) => void
}

export const ActiveSubContext = createContext<ActiveSubContextValue>({
  sub: null,
  promptText: '',
  setActiveSub: () => {},
})

export const useActiveSub = () => useContext(ActiveSubContext)
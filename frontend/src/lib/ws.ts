// WebSocket 进度订阅封装

export type ProgressEvent =
  | { type: 'snapshot'; data: any; ts?: number }
  | { type: 'progress'; value: number; max: number; percent: number; ts?: number }
  | { type: 'node_start'; node: string; ts?: number }
  | { type: 'node_output'; node: string; files: any[]; ts?: number }
  | { type: 'status'; data: any; ts?: number }
  | { type: 'ping'; ts: number }
  | { type: 'done'; files?: any[]; ts?: number }
  | { type: 'error'; error: string; ts?: number }

export function subscribeProgress(
  submissionId: string,
  onEvent: (evt: ProgressEvent) => void,
  onClose?: () => void
): () => void {
  // 同源走 /ws,nginx 会 Upgrade 转发到 18893
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${proto}//${window.location.host}/ws/progress/${submissionId}`
  const ws = new WebSocket(url)

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as ProgressEvent
      onEvent(data)
    } catch (err) {
      console.error('WS parse error', err)
    }
  }
  ws.onerror = (e) => console.error('WS error', e)
  ws.onclose = () => onClose?.()

  return () => {
    if (ws.readyState <= 1) ws.close()
  }
}

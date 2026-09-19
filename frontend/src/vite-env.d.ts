/// <reference types="vite/client" />

// 解决 tsc -p tsconfig.json 报:
//   TS2882: Cannot find module or type declarations for side-effect import of './index.css'
declare module '*.css' {
  const content: string
  export default content
}

// 解决:
//   TS2339: Property 'env' does not exist on type 'ImportMeta'.
// Vite client types (上面 reference) 已经声明 import.meta.env, 但有些 tsconfig
// 配置下 tsc 还是找不到, 加一行 interface 兜底
interface ImportMetaEnv {
  readonly VITE_GALLERY_URL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
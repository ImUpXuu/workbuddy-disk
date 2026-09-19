/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端地址，如 https://your-backend.example.com；留空则走同源 */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

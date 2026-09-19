/**
 * 鉴权上下文。
 *
 * 职责：
 *   - 持有当前凭证状态（有 API Key / 有 token / 都没有）
 *   - 提供登录、登出、切换凭证的入口
 *   - 订阅任意请求的 401 事件，自动清理失效凭证
 *
 * 为什么不直接存 token 到 Cookie：前端与后端不同源，
 * 跨站 Cookie（SameSite=Lax）不会被带上，所以走 localStorage + 请求头。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { api, credentials, onUnauthorized } from '../api/client'
import { uploadEngine } from '../lib/uploadEngine'

export type AuthMode = 'apikey' | 'token' | 'none'

interface AuthState {
  /** 当前使用的凭证类型 */
  mode: AuthMode
  /** 是否已配置凭证（不代表一定有效，有效性由请求结果体现） */
  configured: boolean
  /** 正在验证凭证 */
  checking: boolean
  /** 最近一次验证失败的原因 */
  error: string
}

interface AuthContextValue extends AuthState {
  /** API Key 明文（仅用于设置页回显，脱敏显示） */
  apiKey: string
  /** 用登录密钥换 token */
  loginWithKey(key: string): Promise<void>
  /** 直接设置 API Key（前端主通道） */
  useApiKey(key: string): void
  /** 清除所有凭证 */
  logout(): void
  /** 主动探测凭证是否有效 */
  verify(): Promise<boolean>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function readState(): AuthState {
  const hasKey = !!credentials.getApiKey()
  const hasToken = !!credentials.getToken()
  const mode: AuthMode = hasKey ? 'apikey' : hasToken ? 'token' : 'none'
  return { mode, configured: mode !== 'none', checking: false, error: '' }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(readState)
  const [apiKey, setApiKey] = useState<string>(() => credentials.getApiKey())

  /** 收到 401 时清理凭证（token 会过期，key 可能被停用） */
  useEffect(() => {
    return onUnauthorized(() => {
      credentials.clear()
      setApiKey('')
      setState({ mode: 'none', configured: false, checking: false, error: '凭证已失效，请重新设置' })
    })
  }, [])

  const loginWithKey = useCallback(async (key: string) => {
    setState((s) => ({ ...s, checking: true, error: '' }))
    try {
      const res = await api.login(key)
      credentials.setToken(res.token)
      setState({ mode: 'token', configured: true, checking: false, error: '' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '登录失败'
      setState({ mode: 'none', configured: false, checking: false, error: msg })
      throw err
    }
  }, [])

  const useApiKey = useCallback((key: string) => {
    const k = key.trim()
    credentials.setApiKey(k)
    // 用 API Key 时清掉 token，避免两条通道的凭证互相干扰
    credentials.setToken('')
    setApiKey(k)
    setState(k
      ? { mode: 'apikey', configured: true, checking: false, error: '' }
      : { mode: 'none', configured: false, checking: false, error: '' })
  }, [])

  const logout = useCallback(() => {
    credentials.clear()
    setApiKey('')
    setState({ mode: 'none', configured: false, checking: false, error: '' })
    // 主动登出时停止上传 —— 引擎是模块级单例，不随组件卸载而停，
    // 否则会拿着已清除的凭证一直发请求、一直 401
    void uploadEngine.cancelAll()
  }, [])

  const verify = useCallback(async (): Promise<boolean> => {
    if (!credentials.has()) return false
    setState((s) => ({ ...s, checking: true }))
    try {
      const res = await api.whoami()
      const ok = !!res.authenticated
      setState((s) => ({
        ...s,
        checking: false,
        error: ok ? '' : '凭证无效',
      }))
      return ok
    } catch {
      // 401 会由 onUnauthorized 清理，这里只需收敛 loading 状态
      setState((s) => ({ ...s, checking: false }))
      return false
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, apiKey, loginWithKey, useApiKey, logout, verify }),
    [state, apiKey, loginWithKey, useApiKey, logout, verify],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用')
  return ctx
}

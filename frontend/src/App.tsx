/**
 * 应用根组件。
 *
 * 根据鉴权状态分流：未配置凭证 → 登录页；已配置 → 主界面。
 */

import { useEffect } from 'react'
import { useAuth } from './context/AuthContext'
import LoginPage from './pages/LoginPage'
import DiskPage from './pages/DiskPage'
import ToastHost from './components/ToastHost'

export default function App() {
  const { configured, verify } = useAuth()

  // 已有凭证时静默验一次，失效会自动被 401 监听器清掉
  useEffect(() => {
    if (configured) void verify()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      {configured ? <DiskPage /> : <LoginPage />}
      <ToastHost />
    </>
  )
}

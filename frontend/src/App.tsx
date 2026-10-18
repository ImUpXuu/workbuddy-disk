/**
 * 应用根组件。
 *
 * 路由（hash 路由，见 lib/router）：
 *   - #/d/<path>   磁盘浏览器（需登录）
 *   - #/shares     分享管理（需登录）
 *   - #/s/<token>  公开分享查看（免登录）
 *
 * 根据鉴权状态 + 当前 hash 分流到对应页面。
 */

import { useEffect, useState } from 'react'
import { useAuth } from './context/AuthContext'
import LoginPage from './pages/LoginPage'
import DiskPage from './pages/DiskPage'
import SharesPage from './pages/SharesPage'
import ShareViewPage from './pages/ShareViewPage'
import ToastHost from './components/ToastHost'
import { parseHash, useHashRoute, type RouteState } from './lib/router'

export default function App() {
  const { configured, verify } = useAuth()
  const [route, setRoute] = useState<RouteState>(() => parseHash())

  // 已有凭证时静默验一次，失效会自动被 401 监听器清掉
  useEffect(() => {
    if (configured) void verify()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 跟随 hash 变化（目录浏览、分享下钻、浏览器前进后退都靠它）
  useHashRoute(setRoute)

  // 公开分享视图：免登录，任何人拿到链接都能打开
  if (route.view === 'share') {
    return (
      <>
        <ShareViewPage />
        <ToastHost />
      </>
    )
  }

  return (
    <>
      {configured ? (
        route.view === 'shares' ? <SharesPage /> : <DiskPage />
      ) : (
        <LoginPage />
      )}
      <ToastHost />
    </>
  )
}

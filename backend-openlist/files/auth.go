package middlewares

// 本文件是 OpenList v4.2.9 server/middlewares/auth.go 的定制版，由
// backend-openlist/build.sh 在编译时覆盖进源码树。
//
// 改动点（相对官方）：
//  1. ?token= 优先：CloudStudio 网关会把 Authorization 请求头覆盖成它自己的、
//     在 OpenList 里无法解析的失效 token；只有 query 参数能可靠透传。前端
//     request.ts 会把登录 token 同时放进 ?token=，这里以它为准覆盖 Header。
//  2. query 里「存在」token 键即视为客户端显式声明（值可以是空串），空串表示
//     「我是游客」，用来把网关注入的脏头清空。见 requestToken()。
//  3. 脏头兜底：Authorization 解析失败时，不再一律 401，而是在 guest 可用时
//     降级为游客。否则游客访问首页时 /api/me 返回 401，前端 MustUser 守卫
//     会 bus.emit("to", "/@login?...")，表现为「明明开了 guest 还是被弹到
//     登录页」，且点「使用游客」后会再次 401，形成来回重定向。
//     安全说明：降级只会得到 guest 身份，管理接口后还有 AuthAdmin 拦截，
//     不存在提权；guest 被禁用 / 后端异常时仍然返回 401 / 500。

import (
	"crypto/subtle"

	"github.com/OpenListTeam/OpenList/v4/internal/conf"
	"github.com/OpenListTeam/OpenList/v4/internal/model"
	"github.com/OpenListTeam/OpenList/v4/internal/op"
	"github.com/OpenListTeam/OpenList/v4/internal/setting"
	"github.com/OpenListTeam/OpenList/v4/server/common"
	"github.com/gin-gonic/gin"
	log "github.com/sirupsen/logrus"
)

// requestToken 取本次请求应当采用的 token。
// ?token= 只要「出现」（包括空串）就覆盖 Header：空串是前端对游客身份的明确
// 声明，用来抵消网关塞进来的失效 Authorization 头。
func requestToken(c *gin.Context) string {
	if q, ok := c.GetQuery("token"); ok {
		return q
	}
	return c.GetHeader("Authorization")
}

// fallbackOrAbort 处理「token 有值但解析 / 校验失败」：
// guest 可用 -> 写入 guest 身份并继续；否则按原语义返回 401。
// 参数 allowDisabledGuest 与官方 Auth() 保持一致；Authn() 传 true。
func fallbackOrAbort(c *gin.Context, allowDisabledGuest bool, reason string) {
	guest, err := op.GetGuest()
	if err == nil && (allowDisabledGuest || !guest.Disabled) {
		common.GinAppendValues(c, conf.UserKey, guest)
		log.Debugf("use guest fallback (%s): %+v", reason, guest)
		c.Next()
		return
	}
	if err != nil {
		common.ErrorResp(c, err, 500)
	} else {
		common.ErrorStrResp(c, reason, 401)
	}
	c.Abort()
}

// Auth is a middleware that checks if the user is logged in.
// if token is empty, set user to guest
func Auth(allowDisabledGuest bool) func(c *gin.Context) {
	return func(c *gin.Context) {
		token := requestToken(c)
		if token != "" && subtle.ConstantTimeCompare([]byte(token), []byte(setting.GetStr(conf.Token))) == 1 {
			admin, err := op.GetAdmin()
			if err != nil {
				common.ErrorResp(c, err, 500)
				c.Abort()
				return
			}
			common.GinAppendValues(c, conf.UserKey, admin)
			log.Debugf("use admin token: %+v", admin)
			c.Next()
			return
		}
		if token == "" {
			guest, err := op.GetGuest()
			if err != nil {
				common.ErrorResp(c, err, 500)
				c.Abort()
				return
			}
			if !allowDisabledGuest && guest.Disabled {
				common.ErrorStrResp(c, "Guest user is disabled, login please", 401)
				c.Abort()
				return
			}
			common.GinAppendValues(c, conf.UserKey, guest)
			log.Debugf("use empty token: %+v", guest)
			c.Next()
			return
		}
		userClaims, err := common.ParseToken(token)
		if err != nil {
			fallbackOrAbort(c, allowDisabledGuest, err.Error())
			return
		}
		user, err := op.GetUserByName(userClaims.Username)
		if err != nil {
			fallbackOrAbort(c, allowDisabledGuest, err.Error())
			return
		}
		// validate password timestamp
		if userClaims.PwdTS != user.PwdTS {
			fallbackOrAbort(c, allowDisabledGuest, "Password has been changed, login please")
			return
		}
		if user.Disabled {
			fallbackOrAbort(c, allowDisabledGuest, "Current user is disabled, replace please")
			return
		}
		common.GinAppendValues(c, conf.UserKey, user)
		log.Debugf("use login token: %+v", user)
		c.Next()
	}
}

func Authn(c *gin.Context) {
	token := requestToken(c)
	if token != "" && subtle.ConstantTimeCompare([]byte(token), []byte(setting.GetStr(conf.Token))) == 1 {
		admin, err := op.GetAdmin()
		if err != nil {
			common.ErrorResp(c, err, 500)
			c.Abort()
			return
		}
		common.GinAppendValues(c, conf.UserKey, admin)
		log.Debugf("use admin token: %+v", admin)
		c.Next()
		return
	}
	if token == "" {
		guest, err := op.GetGuest()
		if err != nil {
			common.ErrorResp(c, err, 500)
			c.Abort()
			return
		}
		common.GinAppendValues(c, conf.UserKey, guest)
		log.Debugf("use empty token: %+v", guest)
		c.Next()
		return
	}
	userClaims, err := common.ParseToken(token)
	if err != nil {
		fallbackOrAbort(c, true, err.Error())
		return
	}
	user, err := op.GetUserByName(userClaims.Username)
	if err != nil {
		fallbackOrAbort(c, true, err.Error())
		return
	}
	// validate password timestamp
	if userClaims.PwdTS != user.PwdTS {
		fallbackOrAbort(c, true, "Password has been changed, login please")
		return
	}
	if user.Disabled {
		fallbackOrAbort(c, true, "Current user is disabled, replace please")
		return
	}
	common.GinAppendValues(c, conf.UserKey, user)
	log.Debugf("use login token: %+v", user)
	c.Next()
}

func AuthNotGuest(c *gin.Context) {
	user := c.Request.Context().Value(conf.UserKey).(*model.User)
	if user.IsGuest() {
		common.ErrorStrResp(c, "You are a guest", 403)
		c.Abort()
	} else {
		c.Next()
	}
}

func AuthAdmin(c *gin.Context) {
	user := c.Request.Context().Value(conf.UserKey).(*model.User)
	if !user.IsAdmin() {
		common.ErrorStrResp(c, "You are not an admin", 403)
		c.Abort()
	} else {
		c.Next()
	}
}

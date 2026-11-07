package server

// 本文件是 OpenList v4.2.9 server/webdav.go 的定制版，由
// backend-openlist/build.sh 在编译时覆盖进源码树。
//
// 相对官方只改了 WebDAVAuth 的「取凭证」部分，WebDav / ServeWebDAV /
// tryLogin 以及 WebDAV 协议处理全部保持官方原样。
//
// 背景：CloudStudio 网关会覆盖 Authorization 请求头（塞它自己的失效 token），
// 而 WebDAV 官方实现只认 `Basic user:pass` 或 `Bearer <静态token>`，两者都在
// Authorization 里。因此本地直连 WebDAV 一切正常，经网关则所有 PROPFIND /
// MKCOL / PUT 一律 401，Windows 资源管理器会报「输入的文件夹似乎无效」。
//
// 修复：优先从不会被网关篡改的位置取凭证（query 参数 / 自定义头）：
//   - ?token= / ?key= / ?apikey=（三个别名，兼容旧客户端与之前 Flask 后端）
//   - X-Openlist-Token 自定义请求头（rclone / davfs2 等可配置 header 的客户端）
// 凭证可以是：
//   - 后台「设置 → 其他」里的静态 Token（永不过期，推荐用于长期挂载）
//   - 网页登录拿到的 JWT（48h 有效，后端重启后失效，适合临时使用）
// 解析成功后仍走官方同样的 CanWebdavRead / CanWebdavManage 权限检查，
// 不绕过任何鉴权；凭证无效直接 401，不落入 Basic 分支、不污染登录失败计数。

import (
	"crypto/subtle"
	"net/http"
	"path"
	"strings"

	"github.com/OpenListTeam/OpenList/v4/internal/conf"
	"github.com/OpenListTeam/OpenList/v4/internal/model"
	"github.com/OpenListTeam/OpenList/v4/internal/op"
	"github.com/OpenListTeam/OpenList/v4/internal/setting"
	"github.com/OpenListTeam/OpenList/v4/internal/stream"
	"github.com/OpenListTeam/OpenList/v4/server/common"
	"github.com/OpenListTeam/OpenList/v4/server/middlewares"
	"github.com/OpenListTeam/OpenList/v4/server/webdav"
	"github.com/gin-gonic/gin"
	log "github.com/sirupsen/logrus"
)

var handler *webdav.Handler

func WebDav(dav *gin.RouterGroup) {
	handler = &webdav.Handler{
		Prefix:     path.Join(conf.URL.Path, "/dav"),
		LockSystem: webdav.NewMemLS(),
		Logger: func(request *http.Request, err error) {
			log.Errorf("%s %s %+v", request.Method, request.URL.Path, err)
		},
	}
	dav.Use(WebDAVAuth)
	uploadLimiter := middlewares.UploadRateLimiter(stream.ClientUploadLimit)
	downloadLimiter := middlewares.DownloadRateLimiter(stream.ClientDownloadLimit)
	dav.Any("/*path", uploadLimiter, downloadLimiter, ServeWebDAV)
	dav.Any("", uploadLimiter, downloadLimiter, ServeWebDAV)
	dav.Handle("PROPFIND", "/*path", ServeWebDAV)
	dav.Handle("PROPFIND", "", ServeWebDAV)
	dav.Handle("MKCOL", "/*path", ServeWebDAV)
	dav.Handle("LOCK", "/*path", ServeWebDAV)
	dav.Handle("UNLOCK", "/*path", ServeWebDAV)
	dav.Handle("PROPPATCH", "/*path", ServeWebDAV)
	dav.Handle("COPY", "/*path", ServeWebDAV)
	dav.Handle("MOVE", "/*path", ServeWebDAV)
}

func ServeWebDAV(c *gin.Context) {
	handler.ServeHTTP(c.Writer, c.Request)
}

// davToken 从网关不会篡改的位置取凭证，优先级：query 别名 > 自定义头。
func davToken(c *gin.Context) string {
	for _, key := range []string{"token", "key", "apikey"} {
		if v, ok := c.GetQuery(key); ok && v != "" {
			return v
		}
	}
	return c.GetHeader("X-Openlist-Token")
}

// resolveDavToken 把凭证映射为用户：静态 admin token 或登录 JWT。
func resolveDavToken(token string) (*model.User, bool) {
	if t := setting.GetStr(conf.Token); t != "" &&
		subtle.ConstantTimeCompare([]byte(token), []byte(t)) == 1 {
		admin, err := op.GetAdmin()
		return admin, err == nil
	}
	claims, err := common.ParseToken(token)
	if err != nil {
		return nil, false
	}
	user, err := op.GetUserByName(claims.Username)
	if err != nil || user.Disabled || claims.PwdTS != user.PwdTS {
		return nil, false
	}
	return user, true
}

// davFinish 复用官方 WebDAVAuth 的权限检查与上下文写入（query 与 Basic 共用）。
func davFinish(c *gin.Context, user *model.User, guest *model.User, password string) {
	if user.Disabled || !user.CanWebdavRead() {
		if c.Request.Method == "OPTIONS" {
			common.GinAppendValues(c, conf.UserKey, guest)
			c.Next()
			return
		}
		c.Status(http.StatusForbidden)
		c.Abort()
		return
	}
	switch c.Request.Method {
	case "PUT", "MKCOL", "MOVE", "COPY", "DELETE", "PROPPATCH":
		if !user.CanWebdavManage() {
			c.Status(http.StatusForbidden)
			c.Abort()
			return
		}
	}
	common.GinAppendValues(c, conf.UserKey, user)
	if user.IsGuest() {
		common.GinAppendValues(c, conf.MetaPassKey, password)
	} else {
		common.GinAppendValues(c, conf.MetaPassKey, "")
	}
	c.Next()
}

func WebDAVAuth(c *gin.Context) {
	// check count of login
	ip := c.ClientIP()
	guest, _ := op.GetGuest()
	count, cok := model.LoginCache.Get(ip)
	if cok && count >= model.DefaultMaxAuthRetries {
		if c.Request.Method == "OPTIONS" {
			common.GinAppendValues(c, conf.UserKey, guest)
			c.Next()
			return
		}
		c.Status(http.StatusTooManyRequests)
		c.Abort()
		model.LoginCache.Expire(ip, model.DefaultLockDuration)
		return
	}

	// 网关兼容通道：query / 自定义头优先（Authorization 会被网关覆盖）
	if tok := davToken(c); tok != "" {
		if user, ok := resolveDavToken(tok); ok {
			model.LoginCache.Del(ip)
			log.Debugf("[webdav auth] use query/header token: %s", user.Username)
			davFinish(c, user, guest, "")
			return
		}
		log.Debugf("[webdav auth] invalid query/header token")
		c.Writer.Header()["WWW-Authenticate"] = []string{`Basic realm="openlist"`}
		c.Status(http.StatusUnauthorized)
		c.Abort()
		return
	}

	// 官方原有逻辑：Basic > Bearer(静态 token) > OPTIONS 匿名
	username, password, ok := c.Request.BasicAuth()
	if !ok {
		bt := c.GetHeader("Authorization")
		log.Debugf("[webdav auth] token: %s", bt)
		if strings.HasPrefix(bt, "Bearer") {
			bt = strings.TrimPrefix(bt, "Bearer ")
			token := setting.GetStr(conf.Token)
			if token != "" && subtle.ConstantTimeCompare([]byte(bt), []byte(token)) == 1 {
				admin, err := op.GetAdmin()
				if err != nil {
					log.Errorf("[webdav auth] failed get admin user: %+v", err)
					c.Status(http.StatusInternalServerError)
					c.Abort()
					return
				}
				common.GinAppendValues(c, conf.UserKey, admin)
				c.Next()
				return
			}
		}
		if c.Request.Method == "OPTIONS" {
			common.GinAppendValues(c, conf.UserKey, guest)
			c.Next()
			return
		}
		c.Writer.Header()["WWW-Authenticate"] = []string{`Basic realm="openlist"`}
		c.Status(http.StatusUnauthorized)
		c.Abort()
		return
	}
	user, ok := tryLogin(username, password)
	if !ok {
		if c.Request.Method == "OPTIONS" {
			common.GinAppendValues(c, conf.UserKey, guest)
			c.Next()
			return
		}
		model.LoginCache.Set(ip, count+1)
		c.Status(http.StatusUnauthorized)
		c.Abort()
		return
	}
	// at least auth is successful till here
	model.LoginCache.Del(ip)
	davFinish(c, user, guest, password)
}

func tryLogin(username, password string) (*model.User, bool) {
	user, err := op.GetUserByName(username)
	if err == nil {
		err = user.ValidateRawPassword(password)
		if err != nil && setting.GetBool(conf.LdapLoginEnabled) && user.AllowLdap {
			err = common.HandleLdapLogin(username, password)
		}
	} else if setting.GetBool(conf.LdapLoginEnabled) && model.CanWebdavRead(int32(setting.GetInt(conf.LdapDefaultPermission, 0))) {
		user, err = tryLdapLoginAndRegister(username, password)
	}
	return user, err == nil
}

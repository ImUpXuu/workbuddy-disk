import axios from "axios"
import { api, log } from "."

const instance = axios.create({
  baseURL: api + "/api",
  // timeout: 5000
  headers: {
    "Content-Type": "application/json;charset=utf-8",
    // 'Authorization': localStorage.getItem("admin-token") || "",
  },
  withCredentials: false,
})

instance.interceptors.request.use(
  (config) => {
    // CloudStudio 网关会把 Authorization 请求头覆盖成它自己的失效 token，
    // 但 query 参数能可靠透传。后端 server/middlewares/auth.go 已改为
    // 「query 里出现 token 键就优先覆盖头」，所以每次请求都要显式声明身份：
    //   - 已登录：?token=<JWT>
    //   - 游客：  ?token=（空串），把网关注入的脏头清空，让后端按游客处理
    // 未登录时若不带上这个空 token，后端会拿网关的失效头去 ParseToken 并
    // 返回 401，前端守卫就把游客弹到登录页（guest 明明开着也进不去）。
    // 业务自己传了 token 参数时保持原样，避免覆盖 WebDAV/下载等自定义鉴权。
    const token = localStorage.getItem("token") || ""
    if (config.params instanceof URLSearchParams) {
      if (!config.params.has("token")) config.params.set("token", token)
    } else {
      const params = { ...(config.params || {}) } as Record<string, unknown>
      if (!("token" in params)) params.token = token
      config.params = params
    }
    return config
  },
  (error) => {
    // do something with request error
    console.log("Error: " + error.message) // for debug
    return Promise.reject(error)
  },
)

// response interceptor
instance.interceptors.response.use(
  (response) => {
    const resp = response.data
    log(resp)
    return resp
  },
  (error) => {
    // response error
    console.error(error) // for debug
    // notificationService.show({
    //   status: "danger",
    //   title: error.code,
    //   description: error.message,
    // });
    //
    // 服务端在非 2xx 时同样返回 { code, message, data } 结构（例如初始化
    // 失败会给出 data.reason 说明具体原因）。这里把响应体透传出来：
    //   - message 优先用服务端的文案，避免用户只看到 axios 的
    //     "Request failed with status code 500"；
    //   - data 仅当服务端**确实返回了非空 data** 时才带上（见下方说明）。
    // 网络错误/超时没有 response，退回 axios 的 message。
    //
    // 为什么不能无条件带上 data（哪怕只是 `data: null`）：
    // 分片上传的 mpRequest（pages/home/uploads/multipart.ts）靠「错误对象里
    // 没有 data 键」区分「传输层失败」与「服务端信封」——服务端信封一律带 data。
    // 若这里补一个 data: null，CDN / 网关错误（响应体是 HTML，body.data 为
    // undefined）也会变成"信封"，流控与重试分支会被误判。故仅在 data != null
    // 时附加。
    const body = error.response?.data as
      { message?: string; data?: unknown } | undefined
    const result: {
      code: number | undefined
      message: string
      data?: unknown
    } = {
      code: axios.isCancel(error) ? -1 : error.response?.status,
      message: body?.message || error.message,
    }
    if (body && typeof body === "object" && body.data != null) {
      result.data = body.data
    }
    return result
  },
)

instance.defaults.headers.common["Authorization"] =
  localStorage.getItem("token") || ""

export const changeToken = (token?: string) => {
  instance.defaults.headers.common["Authorization"] = token ?? ""
  localStorage.setItem("token", token ?? "")
}

export { instance as r }

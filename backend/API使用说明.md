# 网盘 API 与设置使用说明

## 一、访问地址

**https://你的域名**

访问密钥：`change-me`

---

## 二、设置页（网页端）

主界面右上角 **⚙ 设置** 打开，包含三块：

### 1. 上传设置

| 项 | 说明 |
| --- | --- |
| **上传并发数** | 同时上传几个文件，范围 1~10。注意并发发生在**文件之间**，每个文件内部的分片仍是顺序传（打散分片反而更容易被网关限流）。 |

### 2. 安全设置

| 项 | 说明 |
| --- | --- |
| **允许 API Key 执行危险操作** | 关闭后，用 API Key 调用的**删除 / 重命名 / 新建文件夹**会被拒绝（返回 403）；网页端操作不受影响。这是防止脚本误删的保险丝。 |
| **新建 Key 的默认有效期** | 单位天，0 表示永不过期。 |

### 3. API Key 管理

- 输入名称点「**＋ 新建 Key**」即可创建
- **明文只显示一次**，创建后立即复制保存；服务端只存 SHA-256 哈希，无法找回
- 每条 Key 支持：**停用 / 启用**、**改名**、**删除**
- 列表显示：前缀、创建时间、过期时间、使用次数、最近使用时间

---

## 三、用 API Key 调用接口

### 传递方式

```bash
# 方式一：查询参数（推荐，线上唯一可靠的方式）
curl "https://你的域名/api/list?apikey=你的KEY"

# 方式二：请求头（本地/内网直连可用）
curl -H "X-API-Key: 你的KEY" "https://.../api/list"
```

> ⚠️ **不要用 `Authorization: Bearer`** —— 线上网关会用自签 JWT 覆盖这个头，导致凭证丢失。用 `?apikey=` 最稳。

### 可用接口（全套权限）

| 方法 | 路径 | 说明 | 危险操作 |
| --- | --- | --- | --- |
| GET | `/api/list?path=<目录>` | 列目录 | |
| GET | `/api/stats` | 存储统计 | |
| GET | `/api/settings` | 读设置 | |
| POST | `/api/settings` | 改设置 | |
| GET | `/api/apikeys` | 列出所有 Key | |
| POST | `/api/apikeys` | 新建 Key | |
| PATCH | `/api/apikeys/<id>` | 启停 / 改名 | |
| DELETE | `/api/apikeys/<id>` | 删除 Key | |
| POST | `/api/upload` | 小文件直传 | |
| POST | `/api/upload/init` | 分片：建会话 | |
| POST | `/api/upload/chunk` | 分片：传一片 | |
| POST | `/api/upload/complete` | 分片：合并 | |
| POST | `/api/upload/abort` | 分片：中止 | ✅ |
| GET | `/api/upload/status` | 查会话状态 | |
| GET | `/api/download?path=<文件>` | 下载（支持断点续传） | |
| POST | `/api/delete` | 删除（可批量） | ✅ |
| POST | `/api/rename` | 重命名 | ✅ |
| POST | `/api/mkdir` | 新建文件夹 | ✅ |

### 调用示例

```bash
KEY="ndk_xxxxxxxxxx_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
BASE="https://你的域名"

# 列出根目录
curl "$BASE/api/list?apikey=$KEY"

# 新建文件夹
curl -X POST "$BASE/api/mkdir?apikey=$KEY" \
  -H 'Content-Type: application/json' \
  -d '{"path":"","name":"备份"}'

# 下载文件
curl -o backup.zip "$BASE/api/download?path=%E5%A4%87%E4%BB%BD%2Fdata.zip&apikey=$KEY"

# 删除文件（需先开启危险操作开关）
curl -X POST "$BASE/api/delete?apikey=$KEY" \
  -H 'Content-Type: application/json' \
  -d '{"paths":["old.txt"]}'
```

---

## 四、大文件上传（脚本调用）

网关对单个请求体有约 **50MB** 限制，超过会直接返回 `413` 且不会到达应用。所以大文件必须分片：

```
1. POST /api/upload/init      → 拿 upload_id、chunk_size(48MB)、total_chunks
2. POST /api/upload/chunk     → 循环传每一片（form-data: upload_id / index / chunk）
3. POST /api/upload/complete  → 合并为完整文件
   失败时 POST /api/upload/abort 清理临时分片
```

网页端已自动处理，无需关心。

---

## 五、注意事项

- **服务重启后所有网页会话失效**：签名盐是进程启动时随机生成的，不落盘。API Key 不受影响，可继续使用。
- **API Key 明文唯一一次**：丢了只能删掉重建。
- **危险开关默认开启**：如需给第三方脚本最低权限，建议关掉它。

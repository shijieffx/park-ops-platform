# 部署说明

**结论：可以部署，项目已经按「单端口服务」组织好**，不需要额外拆分前后端 —— Express 同时提供 `/api/*` 接口和前端构建产物 `dist/`，同源部署，没有跨域和证书问题。

---

## 一、先明确三件事

| 事项 | 现状 | 部署时要注意 |
|---|---|---|
| **端口** | `process.env.PORT \|\| 3001` | 云平台常要求监听 `PORT` 环境变量，已支持 |
| **数据库** | SQLite 单文件（`better-sqlite3`） | 必须挂**持久化卷**，否则容器重建数据丢失 |
| **数据自举** | 启动时检测到空库会**自动生成演示数据** | 无需人工跑 seed，开箱即用 |

`better-sqlite3` 是**原生模块**（含 C++ 编译产物）：
- 官方镜像里装依赖时会下载对应平台的预编译二进制，**用 Debian 系镜像（glibc）最稳**，`node:22-slim` 即可
- **不要用 `node:22-alpine`**（musl libc，多数情况下没有预编译包，需要现场编译，构建慢且容易失败）

---

## 二、三种部署方式

### 方案 A：Docker（推荐，最省心）

项目里已有 `Dockerfile`（多阶段构建）和 `.dockerignore`。

阿里云 / 腾讯云轻量服务器、或本机：

```bash
# 1) 构建镜像（在项目根目录）
docker build -t park-ops:1.0 .

# 2) 启动：把数据挂到命名卷，改掉 JWT 密钥
docker run -d --name park-ops \
  -p 3001:3001 \
  -v park-ops-data:/data \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  --restart unless-stopped \
  park-ops:1.0

# 3) 验证
curl http://127.0.0.1:3001/api/health
```

首次启动会自动生成演示数据（200 设备 / 500 工单 / 1000 告警），日志里能看到：

```
[bootstrap] 数据库为空，正在生成演示数据…
[bootstrap] 演示数据就绪：设备 200 ｜ 工单 500 ｜ 告警 1000
```

**重建不丢数据**：`-v park-ops-data:/data` 是命名卷，`docker compose down` 或换镜像重新 run 时数据仍在。

> 用 `docker-compose.yml` 更规范：
> ```yaml
> services:
>   park-ops:
>     build: .
>     ports: ["3001:3001"]
>     environment:
>       - JWT_SECRET=换成你的随机串
>     volumes:
>       - park-ops-data:/data
>     restart: unless-stopped
> volumes:
>   park-ops-data:
> ```

---

### 方案 B：云服务器直部署（Node + PM2 + Nginx）

适合已有一台 Linux 服务器（Ubuntu 22.04 / CentOS 7+）。项目里已备好 `ecosystem.config.cjs`。

```bash
# ---------- 1. 环境准备（Ubuntu 为例）----------
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx git

# ---------- 2. 拉代码 + 构建 ----------
git clone <你的仓库地址> /opt/park-ops && cd /opt/park-ops
npm install --registry=https://registry.npmmirror.com
npm run build                    # 产出 dist/

# ---------- 3. 用 PM2 常驻 ----------
sudo npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup          # 开机自启
pm2 logs park-ops                # 看日志
```

⚠️ **PM2 必须用 fork 模式、单实例**（配置里已固定）—— SQLite 多进程并发写会锁冲突。

```bash
# ---------- 4. Nginx 反向代理 + 域名 ----------
sudo tee /etc/nginx/sites-available/park-ops > /dev/null <<'EOF'
server {
    listen 80;
    server_name demo.你的域名.com;

    client_max_body_size 20m;          # Excel 批量导入需要

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/park-ops /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# ---------- 5. 免费 HTTPS ----------
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d demo.你的域名.com
```

**域名与备案**：服务器在国内（阿里云/腾讯云）时，域名指向境内 IP 必须完成 **ICP 备案**，否则 80/443 会被拦。没备案的话有两条路：用中国香港等境外节点的服务器（免备案，但延迟略高），或者先只用 `http://IP:3001` 给甲方看。

---

### 方案 C：一键托管平台

适合「今天就想发个链接给甲方」的场景。要求：能跑 Node 服务、能配环境变量、能挂持久化磁盘。

以 Render / Railway 为例：
1. 把项目推到 GitHub
2. 新建 Web Service，关联仓库
3. Build Command：`npm install && npm run build`
4. Start Command：`npm start`
5. 环境变量：`JWT_SECRET=<随机串>`、`DB_PATH=/data/data.db`
6. 挂一个 Persistent Disk 到 `/data`

⚠️ 这类平台**服务器在境外，国内访问可能慢或不稳定**，正式给甲方看建议还是方案 A 或 B。

---

## 三、环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3001` | 监听端口，云平台若指定端口必须用平台给的值 |
| `DB_PATH` | `server/data.db` | SQLite 文件路径，容器内指向挂载卷（如 `/data/data.db`） |
| `JWT_SECRET` | `park-ops-demo-secret` | **上线必须替换**，否则任何人都能伪造 token |

生成随机密钥：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 四、上线后的检查清单

- [ ] `curl http://<地址>/api/health` 返回 `{"code":0,...}`
- [ ] 浏览器打开首页能看到登录页，三个账号都能登录（密码 `123456`）
- [ ] 用 `operator` 登录后，菜单里**看不到**「系统管理」
- [ ] 用 `operator` 的 token 直接请求 `/api/users`，应返回 **403**（不只是前端隐藏）
- [ ] 设备台账的 Excel 导入能上传（Nginx 的 `client_max_body_size` 已放开）
- [ ] 刷新任意子路由（如 `/order`）不出现 404（SPA 回退已在 `app.js` 处理）
- [ ] `JWT_SECRET` 已换成随机串
- [ ] 数据卷已挂载，`docker restart` 后数据仍在

---

## 五、部署给甲方看之前，建议再补两件事

1. **换个像样的标题与 favicon** —— 现在浏览器标签还是框架默认的图标，一眼看出是练手项目
2. **首页加一行环境标识** —— 例如页脚写「演示环境 · 数据为模拟生成」，主动说明数据是假的，比让甲方来问更专业

---

## 六、常见问题

**Q：启动报 `Cannot find module 'better-sqlite3'` 或编译失败**
A：镜像用了 Alpine，或者服务器缺编译工具。换 `node:22-slim`（本项目 Dockerfile 已用）；直部署时若走源码编译，先装 `apt install -y python3 make g++`。

**Q：登录成功但刷新就退出登录**
A：`JWT_SECRET` 每次重启都变（没固定），导致旧 token 验签失败。固定住环境变量即可。

**Q：接口返回 502 / 504**
A：Nginx 反代到了错误端口，检查 `proxy_pass` 与 `PORT` 是否一致。

**Q：`EADDRINUSE` 端口占用**
A：本机已有服务占 3001，`PORT=3002 node server/app.js` 换端口。

**Q：数据被清空了**
A：没挂持久化卷。容器重建后数据库文件回到镜像初始状态，服务会自动重新生成演示数据（这也是为什么没挂卷时看起来「数据自己恢复了」）。

**Q：本地登录正常，部署后所有需要登录的接口都返回 401（reason: invalid signature）**
A：宿主环境**改写了 `Authorization` 请求头**。实测某托管平台会把客户端发出的令牌替换成自己的——客户端发出 253 字符，服务端实际收到 379 字符，令牌因此丢失，验签必然失败。

本项目已内置两层兼容，正常部署不会遇到：
1. 前端**同时**发送 `X-Auth-Token`，服务端优先读它，缺失时才回退到 `Authorization`；
2. 服务端会扫描头里所有形似 JWT 的片段，逐个验签，取通过的那个。

排障时用 `API_DEBUG=1 node server/app.js` 启动，401 响应会附带具体的失败原因。

**Q：页面能打开、列表有数据，但个别图表空白，控制台报 401**
A：该请求绕过了统一请求层（直接 `fetch` + 手写 `Authorization` 头），在会改写该头的环境下必然失败。所有接口调用都应走 `src/api/index.ts`，由它统一附带鉴权头、解包响应与处理错误。定位方式：改用请求头的方式逐条排查，或直接看 `scripts/smoke-ui.mjs` 输出的 4xx URL 清单。

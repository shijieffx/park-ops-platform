# 园区综合运维管理平台 · Python 后端（FastAPI）

与仓库内的 **Node(Express) 版后端并存**的另一套实现。

两套后端：

- **接口契约完全一致** —— 同样的路径、同样的 `{code, data, message}` 结构、同样的状态码与业务规则；
- **共用同一个 SQLite 数据库与同一份前端构建产物**；
- 因此**前端不需要任何改动**，两套实现可以随时互换、并行对比。

前端调用的是 `/api/*`，所以「换后端」对页面是无感的。存在两套实现的价值在于：同一套业务规则下对比两种技术栈的写法，也用一份黑盒测试同时约束两边。

---

## 技术栈

| 类别 | 选型 | 说明 |
|---|---|---|
| Web 框架 | **FastAPI** | 基于类型注解自动生成 OpenAPI 文档（`/docs` 可直接调试接口） |
| ASGI 服务器 | **Uvicorn** | 开发用 `--reload`，生产用多进程 |
| 数据库 | **SQLite（标准库 `sqlite3`）** | 与 Node 版同一个文件；WAL 模式读写并发 |
| 鉴权 | **PyJWT + bcrypt** | 与 Node 版 `jsonwebtoken` / `bcryptjs` 完全互通 |
| 测试 | **pytest + httpx** | 独立临时库，不碰开发数据 |

> 密码哈希刻意选用 `bcrypt` 而不是 `passlib`：它产出的 `$2a$` / `$2b$` 与 Node 版 `bcryptjs` 是同一套格式，
> 因此**同一个用户密码在两边都能校验通过** —— 这是「两套后端共用一份数据」的前提。
> 若换成任何自定义加盐方案，这条就断了。

---

## 目录结构与分层

```
backend/
├── app/
│   ├── main.py           # 应用装配：中间件、路由挂载、静态托管、SPA 回退、启动自举
│   ├── config.py         # 环境变量契约（PORT / DB_PATH / JWT_SECRET / API_DEBUG）
│   ├── db.py             # 连接、建表 DDL、增量列迁移、启动自举入口
│   ├── seed.py           # 演示数据生成（与 Node 版同口径）
│   ├── security.py       # 密码哈希、JWT 签发与解析（含 Authorization 头被改写时的兼容解析）
│   ├── permissions.py    # 角色 → 权限点 / 数据范围（唯一事实来源）
│   ├── errors.py         # 统一响应结构与全局异常处理
│   ├── utils.py          # 时间口径、分页解析、SLA 时限
│   ├── deps.py           # 依赖注入：数据库连接、当前登录人、权限校验、数据范围过滤
│   └── routers/          # 接口层，每个业务域一个 APIRouter
│       ├── auth.py       meta.py      devices.py   inspection.py
│       ├── orders.py     alarms.py    parts.py     ai.py
│       └── users.py      stats.py
├── tests/                # pytest：工具函数单测 + 接口集成测试
├── requirements.txt      # 运行依赖
├── requirements-dev.txt  # 测试依赖
├── pyproject.toml        # 项目元信息与 pytest 配置
├── .env.example          # 环境变量样例
└── Dockerfile            # 容器化部署
```

**分层约定**：`routers`（接口层）→ `deps`（依赖注入 / 鉴权 / 数据权限）→ `utils`·`security`·`db`（基础设施）。
路由只声明自己需要什么（当前用户、连接、权限点），鉴权与数据范围过滤的实现细节全部收敛在 `deps`，
避免每个接口重复写一遍过滤条件 —— 这也是 Node 版把 `scopeFilter()` 抽出来的同一个理由。

---

## 快速开始

```bash
cd backend

# 1) 安装依赖（建议用虚拟环境）
python -m venv .venv
# Windows: .venv\Scripts\activate     macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt

# 2) 启动（默认 8000 端口，与 Node 版的 3001 错开，两套可以同时跑）
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# 3) 打开接口文档
#    http://127.0.0.1:8000/docs
```

启动时会自动完成两件事：**建表**（幂等）与 **数据自举**（库为空才生成演示数据），
所以容器重建、数据卷被清空后开箱即用，不需要人工执行初始化脚本。

体验账号：`admin` / `manager` / `operator`，密码均 `123456`（三者数据范围不同，切换即可对比）。

也可以从项目根目录用 npm 脚本启动：

```bash
npm run backend:py      # 只起 Python 后端（8000）
npm run dev:py          # 同时起 Python 后端 + Vite 前端
```

### 运行测试

```bash
cd backend
python -m pytest                    # 38 项：工具函数单测 + 接口集成测试
```

测试跑在独立的临时库上（`conftest.py` 在导入应用前改写 `DB_PATH`），不会影响开发数据。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8000` | 监听端口。刻意与 Node 版（3001）错开，便于同时启动对比 |
| `DB_PATH` | `../server/data.db` | **默认与 Node 版是同一个文件**，两套后端共用一份数据；填别的路径即可独立 |
| `JWT_SECRET` | `park-ops-demo-secret` | ⚠️ 上线必须换成随机串，否则任何人都能伪造令牌 |
| `API_DEBUG` | 关 | 置 1 时把令牌校验失败原因写入日志，用于排查部署环境差异 |

---

## 与 Node 版的一致性怎么保证

不靠人工比对，靠一份**共用同一套断言的黑盒测试** + 一份**逐字段响应对比脚本**：

```bash
# 1) 黑盒接口自测（82 项断言）—— 两个地址各跑一遍
node scripts/self-test.mjs http://127.0.0.1:3001   # Node 版
node scripts/self-test.mjs http://127.0.0.1:8000   # Python 版

# 2) 逐字段对比两套后端对同一批只读接口的响应（三角色 × 30 个接口）
node scripts/compare-backends.mjs

# 3) 浏览器端到端冒烟（13 个路由）
node scripts/smoke-ui.mjs http://127.0.0.1:8000
```

三者的定位不同：黑盒自测验证**业务规则**两边一致；对比脚本验证**响应结构**逐字段相同；
浏览器冒烟验证**真实页面**在 Python 后端下能正常渲染。

`compare-backends.mjs` 会显式列出「无法逐字节相同」的字段（时间戳、进程信息、实时计算的剩余小时数），
以及为什么 `操作日志` 不进对比（每次登录都会各自写一条日志）—— 不做静默忽略，避免把真实差异掩盖过去。

---

## 设计要点

### 1. 数据权限下沉到 SQL
`deps.scope_filter()` 按角色生成 `(sql, params)`：

| 角色 | 范围 | 生成条件 |
|---|---|---|
| admin | `ALL` | `1=1` |
| manager | `REGION` | `region = ?` |
| operator | `SELF` | 工单看 `handler`、设备看 `owner`、巡检看 `inspector`、告警看 `region` |

因为过滤发生在 SQL 层而不是取出数据后再筛，**分页总数与列表数据天然一致**，
不会出现「第一页 20 条、总数只算 5 条」的错位。

### 2. 越权与不存在返回同一结果
详情 / 编辑 / 删除一律先走 `find_visible()`（把数据范围条件拼进查询），
取不到就统一回 404。这样攻击者无法通过状态码差异探测出「资源是否存在」。

### 3. 时间口径统一为东八区
业务时间全部是「东八区时间字符串」（`YYYY-MM-DD HH:mm:ss`），与数据库 TEXT 列直接对应，前端无需换算。
**不要用 `datetime.utcnow()` 当业务时间** —— 那是 UTC，与按 `+08:00` 解析的 SLA 计算混用会产生 8 小时偏差。

### 4. 连接与事务
- 连接**按请求创建**、用完即关（SQLite 连接很轻，WAL 下可并发读）；
- `check_same_thread=False` 是必须的：FastAPI 把同步端点丢进线程池执行，
  「创建连接的线程」与「执行接口的线程」不保证同一个；
- 写操作设置 5 秒 `busy_timeout`，避免与 Node 版同时写时立刻报 `database is locked`；
- 事务用显式的 `BEGIN / COMMIT / ROLLBACK`（对齐 better-sqlite3 的 `db.transaction` 语义）。
- ⚠️ `executescript()` 会**隐式提交**当前事务，不要在事务内调用它（seed 的清空逻辑即因此放在事务之外）。

### 5. 错误一律回 JSON
未匹配的 `/api/*` 返回 `{code:404, message:"接口不存在：GET /api/xxx"}`，绝不返回 HTML ——
前端统一按 JSON 解包，拿到 HTML 只会提示「请求失败」，看不出真实原因。
FastAPI 默认对参数校验错误回 422，这里统一映射为 400，与 Node 版保持一致。

### 6. 请求日志与缓存策略
`/api/*` 打印一行请求日志便于演示时观察调用；
静态资源按内容哈希区分：带哈希的产物 `immutable` 强缓存一年，`index.html` 每次校验（否则发版后用户会拿到旧页面）。

---

## 已知差异与取舍

| 项 | 说明 |
|---|---|
| 授权端点位于 `/docs` | FastAPI 自带 OpenAPI 文档，Node 版没有。属于**新增能力**，不影响既有接口 |
| 诊断接口 `/api/diag` | 字段是 Python 运行时信息（`python` 版本、进程 RSS 可取时为数值），Node 版对应 `node` 版本 |
| `top_k` 参数 | AI 助手相关，两套后端都不涉及模型调用（模型由前端直连云服务），无差异 |
| 时间基准 | 端口的 `maintain` 统计与看板「待保养」计数统一按东八区取日期（Node 版原有实现按 UTC 取，已同步修正，避免两套后端出现 1 天偏差） |

---

## 部署

### 容器

```bash
# 工作目录必须是项目根（需要一并复制前端产物）
npm run build
docker build -f backend/Dockerfile -t park-ops-py .
docker run -d -p 8000:8000 \
  -v park-ops-data:/data \
  -e JWT_SECRET=$(python -c "import secrets;print(secrets.token_hex(32))") \
  -e DB_PATH=/data/data.db \
  park-ops-py
```

用 Debian slim 而不是 alpine：`bcrypt` 是原生扩展，musl 环境下常常没有预编译 wheel，
会退化成现场编译，构建慢且容易失败。

### 托管平台

托管平台的沙箱只暴露**一个 HTTP 端口**，且不提供外部数据库 —— 本项目用 SQLite，天然适配。
需要注意：

1. 启动命令要监听 `PORT` 环境变量并绑定 `0.0.0.0`：
   `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
2. **AI 助手的模型调用只在原发布域名下被接受**（云服务校验请求来源），
   换域名部署时该功能不生效，其余模块不受影响。

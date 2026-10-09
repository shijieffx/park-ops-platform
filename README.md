# 园区综合运维管理平台 · 个人作品

面向园区 / 厂区 / 政企单位的中后台运维管理系统，**一个人从需求到上线的完整实现**。
前端 Vue3 + TypeScript，后端 Node.js + SQLite，全部代码独立开发，数据为脚本生成的模拟数据。

## 在线体验

**线上地址：https://park-ops-platform.app.workbuddy.host/**

| 账号 | 密码 | 角色 | 可见数据 | 可见菜单 |
|---|---|---|---|---|
| `admin` | `123456` | 系统管理员 | 全部区域 | 含「系统管理」 |
| `manager` | `123456` | 运维主管 | 仅本区域（一号产业园） | 不含系统管理 |
| `operator` | `123456` | 运维专员 | 仅本人相关 | 不含系统管理、报表 |

> 用不同账号登录，首页看板、台账、工单、告警、报表的数据量会明显不同 —— 这是 RBAC **数据范围权限**的直接体现。

## 技术栈

**前端**：Vue3（Composition API + `<script setup>`）· TypeScript · Vite · Vue Router · Pinia · Naive UI · ECharts · ExcelJS
**后端**：Node.js · Express · better-sqlite3 · JWT · bcryptjs
**工程化**：Vite 代理解决开发跨域；生产模式由 Express 同源托管构建产物

## 功能清单

### 1. 权限体系（RBAC）
- **菜单权限**：菜单由后端按角色返回，非管理员看不到「系统管理」
- **数据范围权限**：`ALL` 全量 / `REGION` 本区域 / `SELF` 仅本人相关，作用于设备、工单、告警、报表所有统计
- **操作权限**：`device:edit` / `order:edit` / `system:*` 等权限点在路由与接口双层校验
- 角色 × 菜单权限矩阵可视化

### 2. 设备台账
- 关键词 / 类型 / 区域 / 状态 组合筛选 + 分页
- 新增、编辑、删除（含二次确认）
- **批量导入 Excel**：提供模板下载，逐行校验并回显失败行号与原因
- **导出 Excel**：按当前数据权限导出全量，带表头样式与边框
- **打印台账**：独立打印样式，自动隐藏侧边栏与操作列

### 3. 工单中心
- 状态机流转：`待受理 → 处理中 → 待验收 → 已闭环`（待验收可打回处理中）
- 非法流转在后端拦截（不允许跳级）
- 流转时间轴记录操作人、动作、备注、时间
- 新建工单自动生成单号与首条时间轴

### 4. 告警中心
- 等级（紧急 / 重要 / 次要 / 提示）与状态筛选
- 等级分布柱状图 + 近 30 天趋势折线图
- 一键标记已处理

### 5. 首页看板
- 4 张核心指标卡（设备总数、告警设备、待受理工单、未处理告警）
- 告警趋势、工单状态分布、设备区域分布、设备类型构成四张 ECharts 图
- **所有图表受角色数据范围约束**，切换账号即可看到差异

### 6. 报表中心
- 维度（区域 / 类型 / 状态 / 工单状态 / 告警等级）× 图表类型（柱 / 饼 / 线）自由组合
- 在线预览 + 导出 Excel + 打印

### 7. 系统管理
- 用户管理：增删改、启停、重置密码
- 角色权限：数据范围配置 + 权限矩阵
- 数据字典：下拉选项统一维护

## 快速开始

```bash
npm install          # 安装依赖
npm run seed         # 生成演示数据（200 设备 / 500 工单 / 1000 告警）
npm run dev          # 同时启动后端 3001 与前端 5173
```

打开 http://localhost:5173 ，用上表任一账号登录。

> 国内网络建议加镜像：`npm install --registry=https://registry.npmmirror.com`

其他命令：

```bash
npm run build        # 构建前端到 dist/
npm run preview      # 预览构建产物
```

生产部署时先 `npm run build`，再 `npm run dev:server`，Express 会直接托管 `dist/`，前后端同源。

## 代码质量与自测

```bash
npm run lint        # ESLint：0 error / 0 warning
npm run typecheck   # vue-tsc 类型检查：0 错误
npm run test:api    # 接口自测：36 项断言（服务需已启动）
node scripts/smoke-ui.mjs   # 前端冒烟：无头浏览器逐页检查 + 截图
npm run check       # lint + typecheck
```

接口自测覆盖七个维度：基础可用性、认证、权限点、数据范围、**越权探测**、业务规则、参数边界。
开发过程中它真实抓出并修复了 6 个缺陷，其中 3 个是越权漏洞（主管可读区域外设备、专员可读他人设备与工单）——
这类问题手工点页面发现不了，因为界面上根本不会出现越权的入口。

## 深入阅读

| 文档 | 内容 |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 分层架构、权限模型设计、数据模型、关键流程时序、技术选型取舍 |
| [BUILD-ANALYSIS.md](./BUILD-ANALYSIS.md) | 构建工具链、产物体积分析、优化措施与量化效果、可继续优化项 |
| [DEPLOY.md](./DEPLOY.md) | Docker / PM2+Nginx / 托管平台三种部署方案与排障 |

## 目录结构

```
demo-park-ops/
├── server/                       # 后端
│   ├── app.js                    # Express 入口、中间件装配、静态托管、统一错误处理
│   ├── db.js                     # better-sqlite3 初始化（WAL）与建表
│   ├── seed.js                   # 演示数据生成脚本
│   ├── bootstrap.js              # 启动自举：库为空则自动生成数据
│   ├── middleware/auth.js        # JWT、权限点、数据范围过滤、可见性查询、操作日志
│   ├── routes/                   # auth / meta / devices / orders / alarms / users / stats
│   └── utils/validate.js         # 分页等入参安全解析
├── src/
│   ├── api/index.ts              # 统一请求封装（自动带 token、401 处理、错误解包）
│   ├── store/user.ts             # Pinia 用户态
│   ├── router/index.ts           # 路由 + 权限守卫
│   ├── layouts/                  # 侧边栏布局（菜单由后端按角色下发）
│   ├── views/                    # 登录 / 看板 / 台账 / 工单 / 告警 / 报表 / 系统管理
│   ├── components/EChart.vue     # ECharts 封装（自适应 + 销毁）
│   └── utils/
│       ├── echarts.ts            # ECharts 按需注册（体积优化）
│       └── excel.ts              # Excel 导入导出（exceljs 动态加载）
├── scripts/
│   ├── self-test.mjs             # 接口自测：36 项断言，覆盖越权与边界
│   └── smoke-ui.mjs              # 前端冒烟：无头浏览器逐页检查 + 截图
├── ARCHITECTURE.md               # 项目架构说明
├── BUILD-ANALYSIS.md             # 构建分析与体积优化过程
├── DEPLOY.md                     # 部署方案与排障
└── vite.config.ts                # 开发代理 /api → 3001
```

## 设计说明

- **不套现成后台框架**：布局、路由守卫、请求层、权限模型均手写，体现从零搭建能力
- **权限双层校验**：前端按权限点隐藏入口，后端在中间件层再次校验，前端绕过也无效
- **数据范围下沉到 SQL**：`scopeFilter()` 统一生成 WHERE 条件，避免在每个接口重复写过滤逻辑
- **导入失败可定位**：逐行处理并回显「第 N 行：原因」，而不是整批失败
- **骨架屏 / Loading / 空状态 / 错误兜底**：接口异常有统一提示，列表为空有空状态

---

个人独立开发作品 · 所有数据均为脚本生成的模拟数据，不含任何真实业务信息

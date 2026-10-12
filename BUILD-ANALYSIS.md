# 项目整体构建分析

> 园区综合运维管理平台 · 个人作品 Demo
> 本文记录构建工具链、产物结构、体积优化过程与量化效果、代码质量指标，以及后续可继续推进的方向。

---

## 一、工具链一览

| 环节 | 工具 | 版本 | 说明 |
|---|---|---|---|
| 构建 | Vite | 6.x | 开发态 ESM 直出，生产态 Rollup 打包 |
| 前端框架 | Vue | 3.5 | `<script setup>` + 组合式 API |
| 类型系统 | TypeScript | 5.7 | `strict: true` |
| 类型检查 | vue-tsc | 2.x | 覆盖 `.ts` / `.vue` |
| 代码检查 | ESLint | 9.x | flat config，含 `typescript-eslint`、`eslint-plugin-vue` |
| 后端 | Node.js | 22 | ESM |
| 数据库 | better-sqlite3 | 11.x | 同步 API + WAL |
| 接口自测 | 自研脚本 | — | `scripts/self-test.mjs`，零依赖 |
| 前端冒烟 | 自研脚本 | — | `scripts/smoke-ui.mjs`，通过 CDP 驱动系统 Edge |

**刻意没有引入的东西**：组件库自动导入插件、CSS 预处理器、PostCSS 插件链、单元测试框架。原则是「先让每个依赖都有明确的兑换理由」，避免 node_modules 膨胀到与业务代码不成比例。

---

## 二、构建配置说明

`vite.config.ts` 中与产物相关的只有三项：

```ts
build: {
  outDir: 'dist',
  chunkSizeWarningLimit: 900,
  rollupOptions: {
    output: {
      // 第三方依赖单独分包：业务代码改动不会让用户重新下载整个依赖包
      manualChunks: {
        vue: ['vue', 'vue-router', 'pinia'],
        'naive-ui': ['naive-ui'],
        echarts: ['echarts'],
        exceljs: ['exceljs']
      }
    }
  }
}
```

**为什么手动分包**：不配置的话，Rollup 会把所有 `node_modules` 打进一个大包。分包后有两层收益：

1. **缓存命中率**：业务代码（约 55KB）随每周迭代变化，而依赖包几乎不变。用户升级版本时只需重新下载 55KB，而不是 3MB。
2. **并行下载**：浏览器对同域名可并发多个 HTTP 请求，分包后能并行拉取。

配合服务端缓存策略（见第七节），依赖包可以做到「一年只下载一次」。

---

## 三、产物体积分析

### 3.1 当前产物（39 个文件，主项目 JS 合计 3082.11 kB）

> 不含 `dist/annotation/`（298 kB）—— 那是另一个作品「图像标注工作台」的构建产物，
> 通过 `public/annotation/` 随本项目一起发布，属于独立应用，不计入本项目的体积预算。

| chunk | 原始体积 | gzip 后 | 占比 | 是否首屏 |
|---|---:|---:|---:|---|
| `naive-ui` | 1362.05 kB | 368.17 kB | 44.2% | 是 |
| `exceljs` | 917.93 kB | 263.39 kB | 29.8% | **否（按需加载）** |
| `echarts` | 523.19 kB | 176.22 kB | 17.0% | 是 |
| `vue`（vue + router + pinia） | 105.74 kB | 41.25 kB | 3.4% | 是 |
| `Assistant`（AI 助手，含云服务 SDK） | 77.92 kB | 24.93 kB | 2.5% | **否（路由级懒加载）** |
| 其余业务页面 chunk（17 个） | 93.47 kB | 38.97 kB | 3.0% | 按路由懒加载 |
| CSS（15 个文件） | 9.22 kB | 4.24 kB | 0.3% | 是 |
| `index.html` | 0.55 kB | 0.36 kB | — | 是 |

**新增的 AI 助手没有拖累首屏**：云服务 SDK（约 60 kB）被打进独立的 `Assistant` 路由 chunk，
只有真的进入「AI 助手」页面才会下载，首屏依赖链与加入该功能之前一致。

### 3.2 一眼看出的问题

**业务代码只占 5.6%，依赖包占 94%。** 这是中后台项目的典型特征，也说明优化空间几乎全在依赖侧，而不是业务代码。三个大块（naive-ui / exceljs / echarts）合计占 91%。

---

## 四、优化措施与量化效果

### 4.1 ECharts 按需注册 —— 从 1036KB 降到 536KB

**问题**：`import * as echarts from 'echarts'` 会引入全部图表类型（地图、雷达、桑基、树图…）与全部组件，而项目实际只用到 3 种图表。

**做法**：新建 `src/utils/echarts.ts`，显式注册所需能力：

```ts
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart, LineChart, PieChart,
  GridComponent, LegendComponent, TitleComponent, TooltipComponent,
  CanvasRenderer
])
export default echarts
```

**效果**：1036.31 kB → **535.75 kB**（-48.3%），gzip 后 343.41 kB → 180.77 kB。

**代价**：新增图表类型时必须同步在 `use()` 中注册，否则**运行时静默不渲染**（不报错，只是画不出来）。因此在该文件顶部写了明确注释。

### 4.2 ExcelJS 动态加载 —— 首屏少 940KB

**问题**：`exceljs` 压缩后 940KB，仅用于设备台账的导入导出，却因为静态 `import` 而被塞进首屏依赖链。

**做法**：改为函数内动态 `import()`：

```ts
async function loadExcelJS() {
  const mod = await import('exceljs')
  return mod.default
}
```

Rollup 会自动把 exceljs 拆成独立 chunk，只在用户点击「导入/导出」时才发起请求。

**效果**：首屏不再加载 940KB（gzip 271KB），exceljs 变为独立 chunk 后由浏览器缓存长期复用。

**代价**：首次导入/导出会多一次网络往返（之后走缓存）。

### 4.3 路由级代码分割

每个页面组件用 `() => import('@/views/xxx.vue')` 声明，Rollup 自动按路由拆包。11 个页面 chunk 全部在 2–10KB，单个页面改动不会影响其他页面的缓存。

### 4.4 服务端 gzip 压缩 —— 实际传输降 73%

**问题**：JS 是纯文本，未压缩传输极其浪费带宽。国内服务器带宽成本高，这一项比减包更立竿见影。

**做法**：Express 接入 `compression` 中间件，在中间件链最前面生效。

**实测**（本地起服务 + curl 对比 `Accept-Encoding`）：

| 资源 | 未压缩 | gzip 后 | 降幅 |
|---|---:|---:|---:|
| `naive-ui` chunk | 1,394,704 B | 377,403 B | **-72.9%** |
| `index` chunk | 7,550 B | 3,274 B | -56.6% |
| `index.html` | 546 B | 546 B | 不压缩（小于 1KB 阈值） |

### 4.5 静态资源缓存策略

```
带内容哈希的产物（xxx-a1b2c3d4.js）→ Cache-Control: public, max-age=31536000, immutable
index.html                          → Cache-Control: no-cache
```

**为什么这么分**：产物文件名带内容哈希，内容一变文件名就变，所以可以放心让浏览器缓存一年；而 `index.html` 是入口，必须每次校验，否则发版后用户会一直拿到指向旧资源的 HTML。

### 4.6 优化效果汇总

| 指标 | 优化前 | 优化后 | 变化 |
|---|---:|---:|---:|
| 首屏 JS（原始） | 3537.25 kB | 2093.73 kB | **-40.8%** |
| 首屏 JS（gzip） | 1056.24 kB | 622.44 kB | **-41.1%** |
| 线上实际传输（含服务端 gzip） | 3537.25 kB | 622.44 kB | **-82.4%** |
| 构建耗时 | 36.74 s | 19.46 s | -47.0% |
| 模块数 | 3274 | 3274 | — |

> 构建耗时下降主要来自依赖预构建缓存命中，首次冷启动仍会偏慢。

---

## 五、代码质量指标

| 检查项 | 命令 | 当前结果 |
|---|---|---|
| 代码规范 | `npm run lint` | **0 error / 0 warning** |
| 类型检查 | `npm run typecheck` | **0 错误** |
| 接口自测 | `npm run test:api` | **80 项全部通过** |
| 前端冒烟 | `node scripts/smoke-ui.mjs` | **13 个路由全部通过，0 控制台错误** |
| AI 端到端 | `npm run smoke:ai` | **13 项全部通过**（真实提问 → 等流式回答 → 校验数据引用） |

> 前端冒烟在**非发布域名**下会跳过「AI 助手」页并标注原因：云服务会校验请求来源（Origin），
> 本地 localhost 打开时模型调用必然被拒。这是安全机制，不是代码缺陷，所以脚本按 SKIP 处理而不是判失败。

### 自测覆盖范围

`scripts/self-test.mjs` 覆盖十二个维度，除少数业务流转外**只做只读探测**，不污染数据：

1. 基础可用性（健康检查、首页、SPA 回退、未知 API 返回 JSON）
2. 认证（三角色登录、错误密码、伪造 Token、无 Token）
3. 权限点（专员越权访问系统管理、主管查看操作日志）
4. 数据范围（三个角色的可见数据量应呈包含关系）
5. **越权探测**（主管读区域外设备、专员读他人设备与工单）
6. 业务规则（必填校验、编码唯一、非法状态流转）
7. 参数边界（`page=0`、`pageSize=999999`、非数字分页、非法 JSON 请求体）
8. **巡检闭环**（计划 → 生成任务 → 提交 → 异常自动转工单与告警）
9. **备件库存规则**（超库存领用被拒、负数被拒、领用扣减与入库恢复）
10. **工单 SLA**（按优先级算出的处理时限应为 8/24/72 小时，超时筛选结果确实都是超时）
11. **新模块权限**（专员可执行巡检但不可删计划；经理可维护计划）
12. **AI 数据快照一致性**（快照里的设备数必须等于该角色通过接口能看到的设备数）

第 12 项是为 AI 功能专门加的。它锁的是一个不变量：**喂给模型的数据范围必须与用户在界面上能看到的一致**。
如果两者不等，说明 AI 成了绕过数据权限的旁路 —— 这比普通越权更隐蔽，因为界面上看不出任何异常。

这套自测在开发过程中真实抓出并修复了 8 个缺陷，其中：

- **3 个越权漏洞**（主管读区域外设备、专员读他人设备与工单）—— 手工点页面基本不可能发现，因为界面上根本不会出现越权入口
- **1 个权限粒度问题**（「执行巡检」与「维护巡检计划」共用一个权限点，导致专员能删计划）
- **1 个时间口径问题**（业务时间用 UTC 落库、SLA 按东八区解析，超时判定整体偏 8 小时）
- 其余为健壮性（非数字分页、非法 JSON 请求体返回 500）与体验问题（未知 API 返回 HTML）

`scripts/smoke-ui.mjs` 用系统 Edge 的无头模式 + CDP 协议逐个打开路由，检查关键元素是否渲染（例如首页看板应当有 6 个图表 canvas）、收集控制台报错与 4xx 响应 URL，并输出截图留档。这一步用来兜住「改构建配置导致图表静默不渲染」这类回归。

`scripts/smoke-ai.mjs` 更进一步——它是唯一会**真正调用外部模型**的测试：注入登录态 → 打开 AI 助手 → 等模型目录就绪 → 填入问题 → 发送 → 等流式回答结束，然后校验回答里确实出现了业务数字（说明快照注入生效，而不是模型自己编的）。

---

## 六、可继续优化项

按「收益 / 成本」排序：

| 优化项 | 预期收益 | 成本与风险 |
|---|---|---|
| naive-ui 按需自动导入（`unplugin-vue-components`） | 1.39MB 中可裁掉未使用组件，**具体幅度需实测** | 需引入构建期插件，且要改造组件引入方式，有回归风险 |
| ECharts 按页面二次拆分 | 看板与报表各只加载所需图表 | 收益有限（已按需注册），复杂度上升 |
| 替换更轻量的组件库 | 体积可能减半 | 全量重写 UI 层，性价比低 |
| 引入组件级单元测试（Vitest） | 覆盖组件内部逻辑 | 当前已有接口自测 + UI 冒烟兜底，优先级次之 |
| 接入 CI（GitHub Actions） | push 自动跑 lint / typecheck / build / 自测 | 成本低，值得优先做 |
| 产物 sourcemap 上传错误监控 | 线上问题可定位到源码 | 需配套监控服务 |

**当前不做 naive-ui 按需导入的理由**：它是可见的最大体积项，但改造需要动全部页面组件的引入方式，属于「回归风险 > 当前收益」的改动。项目已通过分包 + gzip + 强缓存把它的实际传输成本压到 377KB 且一年只下载一次，边际收益不高。

---

## 七、部署侧的构建约定

- **构建产物不入库**：`dist/` 在 `.gitignore` 中。仓库只存源码，产物由部署流程现场构建（Dockerfile 内多阶段构建 / 服务器上 `npm run build`）。
- **`@esbuild/win32-x64` 放在 `optionalDependencies`**：它是 Windows 专用二进制包，如果留在 `dependencies`，Linux 服务器执行 `npm ci` 会因平台不匹配直接失败。
- **原生模块的镜像选择**：`better-sqlite3` 是原生模块，Docker 基础镜像必须用 `node:22-slim`（Debian），不能用 `alpine`——alpine 使用 musl libc，没有对应的预编译二进制。
- **不提交数据库文件**：`server/data.db*` 已忽略；服务启动时由 `bootstrap.js` 检测空库并自动生成演示数据，容器重建后依然可用。

---

## 八、构建命令速查

```bash
npm run dev         # 开发：并行启动后端 3001 + 前端 5173（Vite 代理 /api）
npm run build       # 生产构建 → dist/
npm run start       # 启动服务（Express 同源托管 dist 与 /api）
npm run lint        # ESLint 检查
npm run typecheck   # vue-tsc 类型检查
npm run test:api    # 接口自测（需服务已启动）
npm run check       # lint + typecheck 一起跑
```

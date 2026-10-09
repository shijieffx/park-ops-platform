/**
 * ECharts 按需注册
 *
 * 全量 `import * as echarts from 'echarts'` 会把所有图表类型与组件打进产物，
 * 压缩后约 1MB。项目实际只用到「柱状 / 折线 / 饼图 + 直角坐标系 / 提示框 / 图例」，
 * 因此在这里显式注册，未注册的能力不会进入产物。
 *
 * 新增图表类型时，需要同步在上方 import 与 use() 中补齐，否则运行时会静默不渲染。
 */
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer
])

export default echarts

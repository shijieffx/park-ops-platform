"""接口层：按业务域拆分的路由模块，每个文件一个 APIRouter"""

from . import ai, alarms, auth, devices, inspection, meta, orders, parts, stats, users

# 挂载顺序即路由匹配顺序：先具体后通用
ROUTERS = [
    auth.router,
    meta.router,
    devices.router,
    inspection.router,
    orders.router,
    alarms.router,
    parts.router,
    ai.router,
    users.router,
    stats.router,
]

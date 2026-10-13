"""
权限模型常量：角色 → 权限点、角色 → 数据范围、角色中文名。

这里是**唯一事实来源**，登录接口与鉴权依赖都复用同一份，
避免出现「登录时返回的权限」和「接口校验用的权限」两套定义。

⚠️ 必须与 Node 版 ``server/middleware/auth.js`` 保持一致：
两套后端对同一个 token 的判定结果要相同，否则切换后端会出现权限行为差异。
"""

from __future__ import annotations

# 角色 → 可访问的权限点
ROLE_PERMS: dict[str, list[str]] = {
    "admin": [
        "dashboard:view", "assistant:view", "device:view", "device:edit",
        "inspection:view", "inspection:edit", "inspection:plan",
        "order:view", "order:edit", "alarm:view", "part:view", "part:edit",
        "report:view",
        "system:view", "system:user", "system:role", "system:dict", "system:log",
    ],
    "manager": [
        "dashboard:view", "assistant:view", "device:view", "device:edit",
        "inspection:view", "inspection:edit", "inspection:plan",
        "order:view", "order:edit", "alarm:view", "part:view", "part:edit",
        "report:view",
    ],
    # 运维专员负责现场执行：可执行巡检、可查备件；
    # 但不能维护巡检计划与设备/备件台账（inspection:plan / device:edit / part:edit 均未授予）
    "operator": [
        "dashboard:view", "assistant:view", "device:view",
        "inspection:view", "inspection:edit",
        "order:view", "order:edit", "alarm:view", "part:view",
    ],
}

# 角色 → 数据范围：ALL 全部 / REGION 本区域 / SELF 仅本人
ROLE_SCOPE: dict[str, str] = {"admin": "ALL", "manager": "REGION", "operator": "SELF"}

# 角色编码 → 中文名，仅用于日志与展示
ROLE_NAME: dict[str, str] = {
    "admin": "系统管理员",
    "manager": "运维主管",
    "operator": "运维专员",
}

# 数据范围的中文名，AI 助手快照与接口返回共用
SCOPE_TEXT: dict[str, str] = {"ALL": "全部区域", "REGION": "本区域", "SELF": "仅本人相关"}


def perms_of(role_code: str) -> list[str]:
    return ROLE_PERMS.get(role_code, [])


def scope_of(role_code: str) -> str:
    return ROLE_SCOPE.get(role_code, "SELF")


def role_name_of(role_code: str) -> str:
    return ROLE_NAME.get(role_code, role_code)

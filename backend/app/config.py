"""
运行时配置。

环境变量契约与 Node 版完全一致：``PORT`` / ``DB_PATH`` / ``JWT_SECRET`` / ``API_DEBUG``。
唯一区别是 **默认端口不同**（Node 3001 / Python 8000），
这样两套后端可以同时启动、并行对比，不会抢占同一个端口。
"""

from __future__ import annotations

import os
from pathlib import Path

# backend/app/config.py → 上溯两级即项目根（demo-park-ops/）
PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _default_db_path() -> Path:
    """默认数据库文件。

    刻意指向 Node 版使用的同一个文件（``server/data.db``）——
    两套后端共用一份数据，切后端不需要迁移，也不会出现「换个后端数据就变了」。
    需要隔离时用 ``DB_PATH`` 覆盖即可。
    """
    return PROJECT_ROOT / "server" / "data.db"


PORT = int(os.environ.get("PORT") or 8000)
DB_PATH = Path(os.environ.get("DB_PATH") or _default_db_path())

JWT_SECRET = os.environ.get("JWT_SECRET") or "park-ops-demo-secret"
TOKEN_TTL_HOURS = 12

# 打开后会把 token 校验失败的具体原因写进日志，便于排查部署环境差异
API_DEBUG = os.environ.get("API_DEBUG") == "1"

DIST_DIR = PROJECT_ROOT / "dist"

"""
pytest 公共夹具。

⚠️ ``DB_PATH`` 必须在**导入 app 之前**设置 —— ``app/config.py`` 在导入时读取环境变量，
所以这段赋值写在模块最上方，而不是放进夹具里（放夹具里就晚了）。
"""

from __future__ import annotations

import os
import pathlib
import sys
import tempfile

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# 独立临时库：测试绝不碰开发 / 线上使用的那份数据
_TMP_DIR = pathlib.Path(tempfile.mkdtemp(prefix="park-ops-test-"))
os.environ["DB_PATH"] = str(_TMP_DIR / "test.db")
os.environ["JWT_SECRET"] = "pytest-only-secret-key-0123456789abcdef"
os.environ["API_DEBUG"] = "0"

import pytest  # noqa: E402

PASSWORD = "123456"
DIST_INDEX = BACKEND_DIR.parent / "dist" / "index.html"

# 依赖前端构建产物的用例：没有 dist 时跳过而不是失败
needs_dist = pytest.mark.skipif(
    not DIST_INDEX.is_file(), reason="前端产物不存在，请先执行 npm run build"
)


@pytest.fixture(scope="session")
def client():
    """建好表、灌好演示数据、并带上 lifespan 的测试客户端"""
    from fastapi.testclient import TestClient

    from app.db import connect, init_schema
    from app.main import app
    from app.seed import run_seed

    conn = connect()
    init_schema(conn)
    run_seed(quiet=True, conn=conn)
    conn.close()

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def tokens(client) -> dict[str, dict[str, str]]:
    """三角色的请求头：``tokens['admin']`` 即可直接传给请求方法"""
    out: dict[str, dict[str, str]] = {}
    for role in ("admin", "manager", "operator"):
        res = client.post(
            "/api/auth/login", json={"username": role, "password": PASSWORD}
        )
        assert res.status_code == 200, res.text
        out[role] = {"X-Auth-Token": res.json()["data"]["token"]}
    return out

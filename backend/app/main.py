"""
FastAPI 应用装配。

职责：
* 中间件（gzip、缓存头、请求日志）
* 挂载各业务路由
* 健康检查 / 诊断 / API 404 兜底
* 托管前端构建产物（同源部署，SPA 回退）
* 启动自举（库为空则生成演示数据）

启动：``uvicorn app.main:app --host 0.0.0.0 --port 8000``
或直接 ``python -m app.main``
"""

from __future__ import annotations

import logging
import re
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from .config import DIST_DIR, PORT
from .db import DB_PATH, ensure_seed_data, init_schema
from .errors import error_body, install_exception_handlers, success
from .routers import ROUTERS

logger = logging.getLogger("park-ops")

# 带内容哈希的产物可长期强缓存；其余（含 index.html）每次校验
HASHED_ASSET = re.compile(r"-[0-9a-zA-Z_]{8,}\.(js|css|woff2?|ttf|png|jpe?g|gif|svg)$")
STARTED_AT = time.time()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    init_schema()
    print(f"\n  园区综合运维管理平台 · Python 后端已启动")
    print(f"  监听端口：{PORT}（PORT 环境变量可覆盖）")
    print(f"  数据库：{DB_PATH}")
    print(f"  接口文档：http://127.0.0.1:{PORT}/docs")
    print(f"  体验账号：admin / manager / operator（密码均 123456）\n")
    ensure_seed_data()
    yield


app = FastAPI(
    title="园区综合运维管理平台 · API",
    description="与 Node 版并存的一套实现，接口契约完全一致；打开 /docs 可直接调试全部接口。",
    version="1.0.0",
    lifespan=lifespan,
)

install_exception_handlers(app)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def access_log_and_cache(request: Request, call_next: Any):
    """请求日志（仅 /api，便于演示时观察调用）+ 静态资源缓存策略"""
    if request.url.path.startswith("/api"):
        print(f"[{time.strftime('%X')}] {request.method} {request.url.path}")

    response = await call_next(request)
    path = request.url.path
    if not path.startswith("/api"):
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable"
            if HASHED_ASSET.search(path)
            else "no-cache"
        )
    return response


# ------------------------------------------------------------------ 业务路由
for router in ROUTERS:
    app.include_router(router)


# ------------------------------------------------------------------ 健康检查 / 诊断
@app.get("/api/health", tags=["系统"], summary="健康检查")
def health():
    return success({"ok": True, "ts": int(time.time() * 1000)})


@app.get("/api/diag", tags=["系统"], summary="运行时诊断（不含任何密钥信息）")
def diag():
    return success({
        "pid": _pid(),
        "python": _python_version(),
        "uptimeSec": round(time.time() - STARTED_AT),
        "now": int(time.time() * 1000),
        "dbPath": str(DB_PATH),
        "rssMB": _rss_mb(),
      })


def _pid() -> int:
    import os

    return os.getpid()


def _python_version() -> str:
    import platform

    return platform.python_version()


def _rss_mb() -> int | None:
    """进程常驻内存（取不到就返回 None，不影响接口可用性）"""
    try:
        import resource  # type: ignore[import-not-found]  # 仅 Unix

        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
    except Exception:  # noqa: BLE001
        return None


# ------------------------------------------------------------------ API 404 兜底
# 未匹配的接口统一返回 JSON，否则前端会拿到 HTML 导致解析失败
@app.api_route(
    "/api/{rest:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    include_in_schema=False,
)
def api_not_found(rest: str, request: Request):
    original = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    return JSONResponse(
        status_code=404,
        content=error_body(404, f"接口不存在：{request.method} {original}"),
    )


# ------------------------------------------------------------------ 静态托管
# 生产模式：直接托管前端构建产物（同源部署，避免跨域与证书问题）
if (DIST_DIR / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")

# 另一个作品「图像标注工作台」挂载在同一域名的 /annotation 子路径
if (DIST_DIR / "annotation").is_dir():
    app.mount(
        "/annotation",
        StaticFiles(directory=DIST_DIR / "annotation", html=True),
        name="annotation",
    )


@app.get("/", include_in_schema=False)
def index():
    return _index_html()


@app.get("/{full_path:path}", include_in_schema=False)
def spa_fallback(full_path: str):
    """SPA 回退：非 API 路径一律返回首页，刷新子路由不会 404"""
    return _index_html()


def _index_html():
    index_file = DIST_DIR / "index.html"
    if index_file.is_file():
        return FileResponse(index_file, headers={"Cache-Control": "no-cache"})
    return JSONResponse(
        status_code=404,
        content=error_body(404, "前端产物不存在，请先执行 npm run build"),
    )


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")


if __name__ == "__main__":
    main()

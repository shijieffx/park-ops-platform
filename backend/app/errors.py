"""
统一响应结构与异常处理。

约定（与 Node 版逐字节对齐，前端无需区分后端实现）：

* 成功：``{"code": 0, "data": ...}``，需要提示语时再带一个 ``message``
* 失败：HTTP 状态码即为业务码，响应体为 ``{"code": <status>, "message": "..."}``

任何一个接口都不允许把异常直接抛成 500 HTML —— 前端统一按 JSON 解包，
拿到 HTML 会导致「请求失败」这类看不出原因的提示。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("park-ops")

_MISSING = object()


class ApiError(Exception):
    """业务异常：直接携带 HTTP 状态码与给用户看的中文提示"""

    def __init__(self, status: int, message: str, code: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = status if code is None else code


def success(data: Any = _MISSING, message: str | None = None) -> dict[str, Any]:
    """成功响应体。``data`` 省略时只返回 code（+ message）"""
    body: dict[str, Any] = {"code": 0}
    if message is not None:
        body["message"] = message
    if data is not _MISSING:
        body["data"] = data
    return body


def error_body(status: int, message: str) -> dict[str, Any]:
    return {"code": status, "message": message}


def install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=error_body(exc.code, exc.message))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # FastAPI 默认回 422，而前端的统一请求层按 4xx 提示「请求失败」；
        # 这里统一成 400，与 Node 版对非法入参的处理保持一致。
        detail = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(p) for p in detail.get("loc", []) if p != "body")
        message = f"参数不合法：{loc}" if loc else "参数不合法"
        return JSONResponse(status_code=400, content=error_body(400, message))

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "请求失败"
        return JSONResponse(status_code=exc.status_code, content=error_body(exc.status_code, detail))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("[server error] %s %s", request.method, request.url.path)
        return JSONResponse(status_code=500, content=error_body(500, str(exc) or "服务端异常"))

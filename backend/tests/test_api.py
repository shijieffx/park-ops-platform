"""
接口层集成测试（FastAPI TestClient，跑在独立的临时库上）。

与 ``scripts/self-test.mjs`` 的分工：
* 那份 **黑盒** 脚本对两套后端（Node / Python）都跑，用来证明实现等价；
* 这份 pytest 是 **Python 侧** 的白盒补充，断言更贴近实现细节
  （状态码、错误体结构、越权返回 404、数据范围不变量）。
"""

from __future__ import annotations

import json
import re

import pytest

from .conftest import needs_dist

# ------------------------------------------------------------------ 基础可用性


def test_health(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["code"] == 0
    assert res.json()["data"]["ok"] is True


@needs_dist
def test_home_serves_frontend(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "<!doctype html" in res.text.lower()


@needs_dist
def test_spa_fallback_for_sub_route(client):
    """刷新子路由不能 404，否则用户一刷新就白屏"""
    res = client.get("/order")
    assert res.status_code == 200
    assert "<!doctype html" in res.text.lower()


def test_unknown_api_returns_json_not_html(client):
    """未匹配的接口必须回 JSON，返回 HTML 会让前端解析失败且看不出原因"""
    res = client.get("/api/not-exist")
    assert res.status_code == 404
    assert res.json()["code"] == 404
    assert "接口不存在" in res.json()["message"]


def test_diag_does_not_leak_secret(client):
    res = client.get("/api/diag")
    body = json.dumps(res.json(), ensure_ascii=False)
    assert res.status_code == 200
    assert "secret" not in body.lower() or "secretFingerprint" not in body


# ------------------------------------------------------------------ 认证


def test_login_success_returns_token_and_perms(client):
    res = client.post("/api/auth/login", json={"username": "admin", "password": "123456"})
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["token"] and data["user"]["username"] == "admin"
    assert "device:edit" in data["user"]["perms"]


def test_login_wrong_password_and_unknown_user(client):
    assert client.post(
        "/api/auth/login", json={"username": "admin", "password": "nope"}
    ).status_code == 401
    assert client.post(
        "/api/auth/login", json={"username": "nobody", "password": "123456"}
    ).status_code == 401


def test_login_missing_credentials(client):
    assert client.post("/api/auth/login", json={}).status_code == 400


def test_login_with_malformed_json_body(client):
    res = client.post(
        "/api/auth/login",
        content="{not json",
        headers={"Content-Type": "application/json"},
    )
    assert res.status_code == 400


def test_protected_endpoint_requires_token(client):
    assert client.get("/api/devices").status_code == 401


def test_forged_token_rejected(client):
    res = client.get("/api/devices", headers={"X-Auth-Token": "fake.token.here"})
    assert res.status_code == 401


def test_token_accepted_from_custom_header(client, tokens):
    """自定义头 X-Auth-Token 必须被优先识别（部分部署环境会改写 Authorization）"""
    res = client.get("/api/auth/profile", headers=tokens["operator"])
    assert res.status_code == 200
    assert res.json()["data"]["username"] == "operator"


def test_token_signed_by_other_secret_rejected(client):
    import jwt as pyjwt

    forged = pyjwt.encode({"id": 1, "username": "admin", "role_code": "admin"},
                          "wrong-secret", algorithm="HS256")
    assert client.get("/api/devices", headers={"X-Auth-Token": forged}).status_code == 401


# ------------------------------------------------------------------ 权限点与数据范围


@pytest.mark.parametrize("path", ["/api/users", "/api/meta/logs"])
def test_operator_cannot_reach_system_modules(client, tokens, path):
    assert client.get(path, headers=tokens["operator"]).status_code == 403


def test_operator_cannot_create_device(client, tokens):
    res = client.post(
        "/api/devices", headers=tokens["operator"], json={"code": "TMP-1", "name": "x"}
    )
    assert res.status_code == 403


def test_device_count_shrinks_by_role(client, tokens):
    """
    admin 能看到全量，主管与专员都被收窄。

    注意：主管按「区域」过滤、专员按「负责人」过滤，这是两个不同维度，
    彼此并不构成包含关系（某个区域内的设备数完全可能少于某人负责的设备数），
    所以这里不断言「主管一定多于专员」—— 随机数据下那条断言有概率失败。
    """
    totals = {
        role: client.get("/api/devices?page=1&pageSize=1", headers=headers).json()["data"]["total"]
        for role, headers in tokens.items()
    }
    assert totals["admin"] > totals["manager"], totals
    assert totals["admin"] > totals["operator"], totals


def test_cross_scope_detail_is_404_not_403(client, tokens):
    """越权与不存在返回同一结果，避免通过状态码差异探测资源是否存在"""
    devices = client.get("/api/devices/all", headers=tokens["admin"]).json()["data"]
    outside = next(d for d in devices if d["region"] != "一号产业园")
    res = client.get(f"/api/devices/{outside['id']}", headers=tokens["manager"])
    assert res.status_code == 404
    assert "无权访问" in res.json()["message"]


def test_paging_garbage_does_not_500(client, tokens):
    for query in ("page=abc&pageSize=xyz", "page=-1&pageSize=0", "page=1&pageSize=999999"):
        res = client.get(f"/api/devices?{query}", headers=tokens["admin"])
        assert res.status_code == 200, query
        assert res.json()["data"]["pageSize"] <= 100


# ------------------------------------------------------------------ 业务规则


def test_sla_stats_readable_for_every_role(client, tokens):
    """
    三种角色都要能读：数据范围条件会把参数带进 SQL，漏传参数会直接 500。
    （Node 版曾在这里漏参，manager / operator 一直 500 而没被发现 —— 这条就是防回归的）
    """
    for role, headers in tokens.items():
        res = client.get("/api/orders/stats/sla", headers=headers)
        assert res.status_code == 200, f"{role}: {res.text}"
        assert res.json()["data"]["onTimeRate"] >= 0


def test_new_order_gets_sla_deadline(client, tokens):
    res = client.post(
        "/api/orders",
        headers=tokens["admin"],
        json={"title": "pytest 建单", "priority": "高"},
    )
    assert res.status_code == 200
    order_id = res.json()["data"]["id"]

    detail = client.get(f"/api/orders/{order_id}", headers=tokens["admin"]).json()["data"]
    assert detail["statusText"] == "待受理"
    assert detail["overdue"] == 0
    assert detail["resolve_deadline"] > detail["response_deadline"]
    assert detail["timeline"][0]["action"] == "创建工单"


def test_illegal_status_transition_rejected(client, tokens):
    created = client.post(
        "/api/orders", headers=tokens["admin"], json={"title": "状态机校验"}
    ).json()["data"]["id"]
    # 待受理 不允许直接跳到 已闭环
    res = client.post(
        f"/api/orders/{created}/flow", headers=tokens["admin"], json={"to": "CLOSED"}
    )
    assert res.status_code == 400
    assert "不允许" in res.json()["message"]


def test_assign_to_unknown_handler_rejected(client, tokens):
    created = client.post(
        "/api/orders", headers=tokens["admin"], json={"title": "派单校验"}
    ).json()["data"]["id"]
    res = client.post(
        f"/api/orders/{created}/assign",
        headers=tokens["admin"],
        json={"handler": "不存在的处理人"},
    )
    assert res.status_code == 400


def test_part_out_of_stock_rejected_and_stock_consistent(client, tokens):
    parts = client.get("/api/parts?onlyLow=1&page=1&pageSize=1", headers=tokens["admin"])
    part = parts.json()["data"]["list"][0]

    too_many = client.post(
        "/api/parts/apply",
        headers=tokens["admin"],
        json={"partId": part["id"], "qty": part["stock"] + 999},
    )
    assert too_many.status_code == 400
    assert "库存不足" in too_many.json()["message"]

    before = part["stock"]
    ok = client.post(
        "/api/parts/apply", headers=tokens["admin"], json={"partId": part["id"], "qty": 1}
    )
    assert ok.status_code == 200
    assert ok.json()["data"]["stock"] == before - 1
    # 流水记录应同步写入
    records = client.get(
        f"/api/parts/records?partId={part['id']}", headers=tokens["admin"]
    ).json()["data"]["list"]
    assert records[0]["after_stock"] == before - 1
    assert records[0]["before_stock"] == before


def test_inspection_abnormal_creates_alarm_and_order(client, tokens):
    """巡检发现异常 → 自动产生告警与工单（业务闭环的关键一环）"""
    tasks = client.get(
        "/api/inspection/tasks?status=PENDING&page=1&pageSize=1", headers=tokens["admin"]
    ).json()["data"]["list"]
    if not tasks:
        pytest.skip("没有待执行的巡检任务")
    task = tasks[0]

    res = client.post(
        f"/api/inspection/tasks/{task['id']}/submit",
        headers=tokens["admin"],
        json={"results": [
            {"item": "pytest 检查项 A", "result": "正常"},
            {"item": "pytest 检查项 B", "result": "异常", "note": "读数超限"},
        ]},
    )
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["total"] == 2 and data["abnormal"] == 1
    assert len(data["orders"]) == 1

    order = client.get(f"/api/orders?page=1&pageSize=1", headers=tokens["admin"]).json()["data"]
    assert order["total"] > 0

    # 重复提交应被拒绝
    again = client.post(
        f"/api/inspection/tasks/{task['id']}/submit",
        headers=tokens["admin"],
        json={"results": [{"item": "x", "result": "正常"}]},
    )
    assert again.status_code == 400


# ------------------------------------------------------------------ AI 快照一致性

def test_ai_snapshot_respects_data_scope(client, tokens):
    """
    不变量：喂给模型的数据范围必须与该账号在界面上能看到的完全一致。
    一旦不等，AI 就成了绕过数据权限的旁路 —— 比普通越权更隐蔽。
    """
    for role, headers in tokens.items():
        snapshot = client.get("/api/ai/context", headers=headers).json()["data"]["snapshot"]
        visible = client.get(
            "/api/devices?page=1&pageSize=1", headers=headers
        ).json()["data"]["total"]
        hit = re.search(r"【设备】共 (\d+)", snapshot)
        assert hit, f"{role} 快照缺少设备统计"
        assert int(hit.group(1)) == visible, f"{role}: 快照 {hit.group(1)} vs 接口 {visible}"


def test_ai_snapshot_requires_login(client):
    assert client.get("/api/ai/context").status_code == 401

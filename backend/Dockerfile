# Python 后端镜像
#
# 构建（工作目录必须是项目根 demo-park-ops/，因为需要一并复制前端产物）：
#   docker build -f backend/Dockerfile -t park-ops-py .
# 运行：
#   docker run -d -p 8000:8000 -v park-ops-data:/data \
#     -e JWT_SECRET=<随机串> -e DB_PATH=/data/data.db park-ops-py
#
# 说明：用 Debian 版（slim）而不是 alpine —— bcrypt 是原生扩展，
# musl 环境下常常没有预编译 wheel，会退化成现场编译，构建慢且容易失败。

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

# 先装依赖，利用镜像层缓存：仅依赖变化时才重装
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# 后端源码 + 前端构建产物（前端需在构建镜像前执行 npm run build）
COPY backend/ ./backend/
COPY dist/ ./dist/

# 数据库放在挂载卷里，容器重建不丢数据
ENV DB_PATH=/data/data.db
VOLUME ["/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",8000)}/api/health',timeout=4)"

WORKDIR /app/backend

# 必须监听 0.0.0.0，否则容器外访问不到
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

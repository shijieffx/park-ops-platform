# ---------- 构建阶段：编译前端 ----------
FROM node:22-slim AS builder
WORKDIR /app

# 用国内镜像，服务器上装依赖快很多
COPY package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com

COPY . .
RUN npm run build

# ---------- 运行阶段：只保留运行所需 ----------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# 生产依赖（better-sqlite3 是原生模块，必须在运行镜像里安装）
COPY package*.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com \
    && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY server ./server

# 数据落在挂载卷上，容器重建不丢数据（卷为空时服务会自动生成演示数据）
ENV PORT=3001
ENV DB_PATH=/data/data.db
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/app.js"]

# ============================================================
# 政策知识库 · 生产镜像
# 统一网关 = OAuth 登录 + 10 表只读 + 审核/订阅/采集写链路 + 自建前端托管
# 入口：policy-api/src/server.js（单进程单端口，PORT 默认 3000）
# ============================================================
FROM node:20-alpine

# tini 负责回收僵尸进程 + 转发 SIGTERM，保证 docker stop 能优雅退出
RUN apk add --no-cache tini wget

WORKDIR /app

# ① 先装依赖，利用 Docker 层缓存（改代码不会重装依赖）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# ② 业务代码（前端自持：policy-api/public/ = 总览首页 / + 审批台 /admin/，随包部署）
COPY src/ ./src/
COPY policy-api/ ./policy-api/
COPY public/ ./public/

# ③ 本地数据目录（db.json：审核单/订阅/采集队列/待同步 outbox）
#    必须挂 volume，否则容器重建即丢写操作
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# ④ 以非 root 运行
USER node

# ⑤ 健康检查：网关已内置 GET /healthz（不需要登录）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "policy-api/src/server.js"]

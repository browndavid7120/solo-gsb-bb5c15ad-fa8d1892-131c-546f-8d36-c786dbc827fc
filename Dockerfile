FROM node:20-bookworm-slim

# better-sqlite3 通常使用预编译二进制；保留编译工具链以兜底从源码构建
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# SQLite 数据库文件目录（可挂载卷持久化）
ENV DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# 初始化数据库（建表，幂等）后启动服务
CMD ["sh", "-c", "node src/db.js && node src/server.js"]

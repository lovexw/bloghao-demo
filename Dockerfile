# bloghao-demo 演示体验站镜像：主仓库 docker-poc 同款形态——一个 Node 进程跑一个演示租户
# （node:26-alpine + 打包后的 server.js + public/，约 70MB，无原生模块：SQLite 用内置 node:sqlite）。
# 构建上下文 = 本仓库根目录：docker build -t bloghao-demo .

FROM node:26-alpine AS build
WORKDIR /app
# 依赖分两层装：先 devDeps（esbuild，打包用），产物进运行层后只重装 prod（hono）
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY src/ ./src/
COPY public/ ./public/
COPY schema.sql ./
# COPY 对目录是「拷内容、不拷目录本身」，server.ts / shims 显式落位
COPY server/server.ts ./server/
COPY server/shims/ ./server/shims/
RUN npm run build

FROM node:26-alpine
WORKDIR /app
# 保持 server/dist 的目录层级，server.js 的相对默认路径（../../public、../tenants.json）与本地一致
ENV NODE_ENV=production PORT=8787 \
    TENANTS_DIR=/data/tenants \
    TENANTS_CONFIG=/app/server/tenants.json \
    PUBLIC_ROOT=/app/public
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/server/dist/server.js ./server/dist/server.js
COPY server/tenants.json ./server/tenants.json
COPY public/ ./public/
# 预建数据目录并归 node：named/匿名卷首次挂载会继承这里的属主；
# Linux bind mount 的 root 属主目录由 entrypoint.sh 在运行期修正
RUN mkdir -p /data/tenants && chown node:node /data/tenants \
    && apk add --no-cache su-exec
COPY --chmod=0755 server/entrypoint.sh /usr/local/bin/entrypoint.sh
VOLUME /data/tenants
EXPOSE 8787
# 不用 USER node：entrypoint 以 root 起步修属主后经 su-exec 降权，应用进程非 root
ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "server/dist/server.js"]

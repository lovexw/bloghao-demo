# bloghao-demo 服务器部署（Docker）

> 再强调一次：**演示体验版，非最新正式版，仅供测试体验，数据每 2 小时自动清空重置**。
> 目标：一台 VPS 上 15 分钟内跑起一个公开可访问的演示体验站。

## 1. 装 Docker

```bash
curl -fsSL https://get.docker.com | sh
```

国内机器拉镜像慢时，给 Docker 配镜像加速器（各云厂商都有文档）。

## 2. 上代码

`git clone` 本仓库（配 deploy key 或走 HTTPS），或本地 `tar` 打包 `scp` 上去，二选一。

## 3. 起服务

```bash
cd bloghao-demo
docker compose up --build -d
docker compose logs -f          # 看到「已启动」与 [tenant] 就绪即成功
```

端口方案二选一：

- **独占机器**：`XWLBLOG_PORT=80 docker compose up --build -d`，容器直接挂 80；
- **与面板共存**（1Panel/openresty 占 80）：`XWLBLOG_BIND=127.0.0.1 docker compose up -d`，
  只监听回环，公网流量交给反代。

镜像约 70MB（node:26-alpine + 打包后的 server.js + 静态资源），无原生模块，ARM/x86 都能跑。
Linux 上 `./data` 宿主目录属主不用手工准备——容器入口 `entrypoint.sh` 以 root 起步把数据卷
chown 给 node 后降权运行（与官方 postgres 镜像同款模式）。

## 4. 域名与 HTTPS（可选，但建议）

任意 Host 都能访问本演示站（单租户自动回落），所以最小部署「IP:端口」即可用。想上域名：

1. 域名 A 记录指到服务器 IP；用 Cloudflare 的话开橙云代理；
2. **反代必须带 `proxy_set_header Host $host;`**（应用按 Host 头路由，丢了会被当成未知域名；
   单租户形态下虽会自动回落，但 canonical/会话 cookie 会更稳健）；
3. HTTPS：Cloudflare 灵活 SSL（访客 HTTPS → 源站 HTTP:80）最快；或 Caddy/openresty 终结 TLS，
   应用侧靠 `X-Forwarded-Proto` 自动恢复 Secure cookie，无需配置。

示例（Caddyfile）：

```
demo.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

## 5. 验证清单

- 打开 `http://站点地址/` → 顶部应有橙色横幅「🎓 演示体验版（非最新正式版）· 仅供测试体验 ·
  数据每 2 小时自动清空重置」，首页有种子文章；
- `/admin/` → 登录页公示演示账号并已自动填充（demo / demo1234），进去能发文章、传图、换主题；
- `/member` → 用 demo / demo1234 登录会员，看会员卡与积分；打开《会员专享》文章能解锁付费墙；
- 《加密演练》文章 → 输入 demo1234 解锁；
- `/rank` → 排行榜有演示会员；
- 等 2 小时（或重启容器删掉 `data/`）→ 内容恢复初始种子状态。

## 6. 运维

- **日志**：`docker compose logs -f`（每条请求一行：方法/路径/状态码/耗时）；
- **备份**：演示站默认关闭备份 cron（数据随时清空，没有备份价值）；宿主机 `./data/` 目录
  即全部状态，想保留当前快照直接 `tar` 打包它；
- **升级**：`scripts/sync-from-bloghao.sh` 同步主仓库最新代码 → `git pull` 到服务器后
  `docker compose up --build -d`，数据卷不动；
- **重置**：手动立即重置 = `docker compose down && rm -rf ./data && docker compose up -d`；
- **安全**：演示站故意公开管理员账号，请勿与任何真实业务混跑在一台机器的同一容器里；
  云安全组只放 22/80/443。

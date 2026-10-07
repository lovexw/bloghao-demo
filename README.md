# bloghao-demo —— 博客号 BlogHao 演示体验站（Docker 自托管）

> ## ⚠️ 先读这个
>
> **这是「博客号 BlogHao」的演示体验版，非最新正式版，仅供测试体验。**
>
> 站内的一切数据——文章、微博、评论、会员、积分、设置、上传的图片——都是自动播种的演示种子，
> **每 2 小时自动清空重置一次**，随时可能被恢复为初始状态。请不要在这里存放任何真实数据。
>
> 这份声明同时公示在系统里：**每张公开页顶部的橙色横幅**、**后台登录页**、**关于页**，以及
> 全站 `noindex`（不进搜索引擎）。

演示账号全部公开，无需申请：

| 位置 | 账号 | 密码 |
|---|---|---|
| 后台（`/admin/`） | `demo` | `demo1234` |
| 会员（`/member`） | `demo` | `demo1234` |
| 访问密码演示文《加密演练：这篇文章带访问密码》 | — | `demo1234` |

## 体验范围（一个都不少）

演示站跑的是与正式版**同一份业务代码**，功能全部开放：

- **博客 + 微博**：发布、编辑、定时发布、草稿箱、置顶、话题、评论（含楼中楼与先审后展）
- **会员体系**：注册/登录、会员卡、每日登录 +1 积分、评论过审 +2 积分、排行榜、档位徽标、
  **会员专享文付费墙**（《会员专享：博客第二年的完整运营数据》）
- **文章访问密码**：《加密演练：这篇文章带访问密码》，解锁流程全程可玩
- **全文搜索**（FTS5 中文分词）、RSS、归档、友链、留言板、独立页面、书单
- **后台管理**：写作编辑器（截图粘贴/Markdown/插件）、主题一键切换（六套）、媒体库、
  数据统计、评论审核、皮肤/插件市场
- **演示守卫**：禁改管理员密码、禁一键闭站、禁外发通知（TG/webhook）——防止有人把体验站改坏

## 快速开始

```bash
docker compose up --build -d
# 打开 http://<服务器IP>:8787 —— 首次访问自动建表 + 播种，无需任何初始化命令
```

- 只登记了一个演示租户，**任意域名/IP/localhost 访问都会自动路由到它**，不用改配置；
- 数据落在宿主机 `./data/`（SQLite 库 + 磁盘图床），容器重建不丢（两次重置之间）；
- 端口与监听地址：`XWLBLOG_PORT=80 docker compose up -d`（独占机器）或
  `XWLBLOG_BIND=127.0.0.1 docker compose up -d`（挂回环给反代，见 DEPLOY.md）。

不用 Docker 也可以直接跑（需要 Node ≥ 22.5，SQLite 用内置 node:sqlite，无原生依赖）：

```bash
npm install
npm run build && npm start      # 或 npm run dev
npm run smoke                   # 端到端冒烟：播种/横幅/搜索/会员/付费墙/密码解锁/演示守卫
```

## 它和官方仓库的关系

本仓库是「博客号 BlogHao」官方仓库（Cloudflare Workers 版）的**演示站发行版快照**：

- `src/`、`public/`、`schema.sql` 从主仓库同步而来，`server/`（Node 适配层）、
  `Dockerfile`、部署文档是本仓库自有；
- 运行机制与官方演示站一致：`DEMO_MODE=1` 驱动自动播种（`src/demo.ts`）、每 2 小时的第 23
  分钟 cron 清库重灌、演示守卫；
- 想把演示站更新到主仓库最新代码：

```bash
scripts/sync-from-bloghao.sh [主仓库路径]   # 缺省 ../xiaowu-bloghao，可用 BLOGHAO_REPO 指定
docker compose up --build -d               # 重新构建即升级
```

## 配置参考

环境变量（一般不用改）：

| 变量 | 缺省 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `TENANTS_DIR` | `server/data/tenants`（Docker：`/data/tenants`） | 数据根（每个租户一个目录：blog.db + uploads/） |
| `TENANTS_CONFIG` | `server/tenants.json` | 租户配置 |
| `PUBLIC_ROOT` | `public/` | 静态资源根 |
| `TRUST_PROXY` | `1` | 信任反代注入的访客 IP 头；Node 直接暴露公网时设 `0`（防伪造头绕过限流） |

`server/tenants.json`：默认 `{"demo.localhost": {"demo": true}}`。本仓库里 `demo` 缺省即开；
只登记一个租户时任意 Host 自动回落，登记多个租户则严格按 Host 匹配。

重置周期：与官方演示站同为每 2 小时的第 23 分钟（UTC cron `23 */2 * * *`，服务内建，无需外挂）。
想立即重置：`docker compose restart` 后删掉 `./data/` 下租户目录再启动，或等下一个周期。

## License

与官方仓库一致，见 [LICENSE](LICENSE)。

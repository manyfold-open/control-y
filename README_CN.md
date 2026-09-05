# Manyfold Agent 的 Cloudflare Worker 起步模板

[English](README.md) · 中文

一个预置了 [Manyfold](https://manyfold.ai) AI agent 连接能力的 Cloudflare Workers 应用模板。
一键部署，在页面里连接你的 Manyfold agents，用流式聊天验证链路 —— 然后在一套已经跑通的
技术栈上，构建你真正想做的应用。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/manyfold-open/cloudflare-worker-starter)

```
┌──────────────┐    ┌───────────────┐    ┌────────────────────┐    ┌──────────────────┐
│ 1. 部署      │ →  │ 2. 打开你的   │ →  │ 3. 连接 agent      │ →  │ 4. 聊天验证，    │
│  (按钮或     │    │    Worker URL │    │  （在 Manyfold 上  │    │    然后开始构建  │
│  fork+Builds)│    │               │    │    授权批准）      │    │    你的应用      │
└──────────────┘    └───────────────┘    └────────────────────┘    └──────────────────┘
```

## 你会得到什么

- **连接 agent** —— 与 Manyfold 之间的设备码（device-code）授权握手：弹窗打开 Manyfold
  的授权页，你核对确认码、勾选要共享的 agents 即可。Bearer token 以 AES-GCM 加密存入你的
  D1 数据库，永远不会到达浏览器。
- **聊天** —— 与每个已连接 agent 的流式聊天（A2A `message/stream` over SSE）。对话持久化
  在 D1 中，并保留 agent 侧的 `contextId`，刷新页面后多轮上下文依然有效。
- **设置页** —— 查看所有已连接的 agents，重新运行（免费、不计费的）连通性探测，断开连接，
  或继续连接更多。重复授权同一个 agent 会原地轮换它的 token。
- **一个干净的迭代起点** —— Vite + React 19 + Hono 跑在同一个 Worker 上，D1 采用零迁移
  schema，几乎没有魔法。加一个路由、一张表、一个组件，直接发布。

## 部署

### 路径 A —— Deploy to Cloudflare 按钮（推荐）

> [!IMPORTANT]
> **在 Cloudflare 表单中点击 "Deploy" 之前，请先展开一次 "Advanced settings" 区域。**
> 截至 2026 年 8 月，Cloudflare 控制台存在一个 bug：该区域折叠时，其中的隐藏字段
> （构建 API token、非生产分支部署命令）不会被初始化 —— 流程会在创建仓库后静默卡住，
> 且不显示任何错误。展开该区域后字段会自动填充，部署即可正常完成。这是控制台侧的
> 问题，与本模板无关。

点击上方按钮，Cloudflare 会：

1. 在你的 GitHub/GitLab 账户中创建这个仓库的副本；
2. 根据 `wrangler.jsonc` 自动创建 D1 数据库，并把真实的 `database_id` 写入你的副本；
3. 将仓库接入 **Workers Builds** —— 之后每次 push 到 `main` 都会自动构建
   （`npm run build`）并部署（`npx wrangler deploy`）。

不需要配置任何 secret。打开 Worker URL，你就已经到了流程图的第 2 步。

### 路径 B —— fork / 使用模板，自己接入 Workers Builds

1. 在 GitHub 上 fork 本仓库（或点 "Use this template"）。
2. 创建数据库：`npx wrangler d1 create manyfold-app-db`，把返回的 `database_id` 填入
   `wrangler.jsonc`。
3. 在 Cloudflare 控制台：**Workers & Pages → Create → Connect to Git**，选择你的 fork，
   构建命令填 `npm run build`，部署命令填 `npx wrangler deploy`。
4. push 到 `main` —— Workers Builds 会完成部署。

### 部署之后（两条路径通用）

URL 公开后强烈建议设置 —— 否则任何拿到 URL 的人都能用你的 agents 聊天（消耗你的额度）：

```bash
npx wrangler secret put ADMIN_PASSWORD
```

可选，让凭证加密密钥不落在数据库里（见[安全说明](#安全说明)）：

```bash
npx wrangler secret put CONFIG_ENCRYPTION_KEY
```

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 然后取消注释 MANYFOLD_API_BASE_URL / ENVIRONMENT
npm run dev
```

一条命令启动全部：Vite 以 HMR 方式服务 React 应用，Worker 运行在 workerd 中并**自动模拟
本地 D1 数据库** —— schema 在第一个请求时自动创建，永远不需要迁移步骤。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发服务器（前端 + worker + 本地 D1） |
| `npm run check` | 类型检查、构建、`wrangler deploy --dry-run` |
| `npm test` | 单元测试（vitest） |
| `npm run deploy` | 手动部署（通常由 Workers Builds 完成） |
| `npm run smoke -- <url>` | 对部署运行冒烟测试 |

## 架构一览

```
浏览器（React SPA，dist/client）
   │  /api/*（run_worker_first）             其余请求 → 静态资源
   ▼
Hono 应用（src/worker/index.ts）
   │ ensureSchema → Origin 校验 → 管理密码门
   ├─ /api/connect*   src/worker/connect.ts   Manyfold 设备码授权握手
   ├─ /api/agents*    src/worker/connect.ts   列表 / 验证 / 断开
   ├─ /api/agents/:id/chat  src/worker/chat.ts  SSE 透传 + 持久化
   ▼
D1（settings、connect_sessions、agents、conversations、messages）
Manyfold A2A（message/stream、tasks/get）   ← 每个 agent 独立的 bearer token，调用时解密
```

| 文件 | 用途 |
| --- | --- |
| `src/worker/index.ts` | 路由、中间件、错误映射 |
| `src/worker/connect.ts` | Manyfold 授权握手与已连接 agent 的存储 |
| `src/worker/a2a.ts` | A2A JSON-RPC + SSE 流消费器、SSRF 防护、密钥脱敏 |
| `src/worker/chat.ts` | 一轮聊天：上游 agent SSE 进、应用 SSE 出、D1 持久化 |
| `src/worker/crypto.ts` | AES-GCM 加解密、常量时间比较 |
| `src/worker/db.ts` | schema（运行时自动应用）与设置存储 |
| `src/shared/types.ts` | worker 与浏览器共享的 API 类型 |
| `src/app/` | React 应用：聊天 + 设置两个标签页、连接面板、密码门 |

## 如何扩展

这个模板是起点，不是框架。预期的迭代方式：

- **加 API 路由** —— 在 `src/worker/index.ts` 中添加；除 `/api/health` 和 `/api/state`
  外的路由在设置了管理密码后会自动受保护。
- **加数据表** —— 在 `src/worker/db.ts` 的 `SCHEMA` 里追加
  `CREATE TABLE IF NOT EXISTS …`；下一个请求就会创建，本地和线上都一样。
- **加页面** —— 在 `src/app/App.tsx` 中添加组件和标签页。
- **在服务端代码里调用你的 agent** —— `src/worker/connect.ts` 的
  `credentialFor(env, agentId)` 会返回任意已连接 agent 的 `{ rpcUrl, token }`；完整的流式
  调用见 `src/worker/chat.ts`，后台任务也可以改用非流式的 `message/send` + `tasks/get`。

`AGENTS.md` 列出了迭代时必须保持的不变量 —— 对人类和 AI agent 都适用。

## 安全说明

- **设备码握手的设计保证凭证永远不经过浏览器。** 浏览器只拿到一个不透明的 `connectId`；
  设备码（唯一能兑换 agent token 的东西）加密存放在 D1 中，且只能兑换一次。页面上显示的
  确认码是这个流程的防钓鱼校验 —— Manyfold 授权页必须显示同一个码。
- **Agent token 以 AES-GCM 加密存储**，密钥来自 `CONFIG_ENCRYPTION_KEY`；为了让一键部署
  零配置可用，未设置时会在首次使用时生成随机密钥并存入同一个数据库。这个取舍是诚实的：
  生成的密钥能防住部分暴露（日志、单表查询），但防不住整库导出。设置 secret 即可消除
  这个隐患。
- **应用默认是开放的。** 在设置 `ADMIN_PASSWORD` 之前，任何拿到 URL 的人都能连接 agent
  并聊天。设置后，除 `/api/health` 和 `/api/state` 外的所有路由都需要密码（常量时间比较；
  通过 header 传输，存放在 sessionStorage）。
- Agent 的 RPC URL 会被校验（仅允许 https，生产环境拒绝私有/回环地址）；连通性验证使用
  不计费的 `tasks/get` 探测而非真实对话；所有错误信息在到达日志或浏览器之前都会剥离
  任何形似 token 的内容。

## 许可证

[MIT](LICENSE)

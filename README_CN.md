# Ctrl+Y

[English](README.md) · 中文

基金经理把一份交付物发出去评审，带着意见回来。再发一次，再回来。Ctrl+Y 把这个循环收拢：
一组 agent 组成的评审小组对照源文档通读交付物，一个汇总 agent 把它们各自发现的问题合并成
一份清单，每条问题指派给唯一能回答它的那个人，回复贴回来之后，小组再跑一轮。

产品里只有一个数字：每一轮之后仍未关闭的问题数 —— 18，然后 14，然后 12，然后归零。

## 一次评审是怎么跑的

1. **把文档交给它。** 交付物，加上一切约束它的材料：合伙协议、side letter、投资组合活动
   记录、各类主数据清单。
2. **跑一轮（pass）。** 每个启用的 agent 各自独立通读文档 —— 一人一轮对话，不共享上下文，
   所以谁的判断都不会染上别人的颜色。随后汇总 agent 一次性拿到全部发现，返回一份合并好、
   已指派、已起草的问题清单。
3. **处理清单。** 每条问题会说明哪里不对、为什么重要，引用它所依据的证据，并写明该由谁回答。
   小组内部有分歧时，分歧本身和最终裁定都会摆出来。同一个人需要回答的所有问题，可以一次
   复制成一封完整的信。
4. **把回复贴回来。** 汇总 agent 拿回复逐条比对未关闭的问题，给出关联建议 —— 这条解决了它、
   这条只答了一部分、这条与它冲突。每条关联由你决定接受还是拒绝。
5. **跑下一轮。** 已回答的问题退出清单，被改写的会说明改了什么，新出现的标记为新增。
6. **关闭评审。** 复盘 agent 写出收尾结论 —— 哪些做对了、下次要改什么 —— 并提出可带入下个
   周期的规则。每条规则都会以“未启用”状态写进记忆，只有你打开它才会生效。

## 工作区

- **Reviews（评审）** —— 全部评审，最新在前，每条后面跟着它历轮的问题数。
- **People（人）** —— 通讯录，以及每个人在当前评审中的职责说明。指派看的是这个职责说明而不是
  通讯录里的岗位，所以要改的也是它。
- **Memory（记忆）** —— 在评审之间沉淀下来的东西：与对手方已经谈定的 *Treatment*、反复出现的
  *Pattern*、你自己的 *Instruction*、关于基金的 *Fact*。一条记忆只有同时“已启用”且“作用于本次
  评审”时才会生效。
- **Agents（小组）** —— 评审小组本身。每个 agent 就是一段有明确职责的提示词：内置四个评审
  agent，外加唯一的汇总 agent 和唯一的复盘 agent。提示词就是这个产品的配置面 —— 不存在用来
  调裁决规则的开关。
- **Connections（连接）** —— 小组实际运行所依赖的 Manyfold agents。连接走 device-code 授权
  握手：弹窗打开 Manyfold 授权页，你核对确认码，勾选要共享的 agent。Token 加密存储，永远不会
  到达浏览器。

新工作区会自带一个进行中的评审和两个已关闭的评审 —— 空清单说明不了这个产品是干什么的。它们
落地即是普通数据：可以改、可以重跑、可以删。

## 本地运行

需要 Node 22+、一个 Cloudflare 账号，以及至少一个可供小组运行的 Manyfold agent。

```bash
npm install
npm run dev
```

这条命令会把 React 应用、Worker 和本地 D1 一起跑在 http://localhost:5173。数据库 schema 在第一次
请求时建好，没有迁移步骤。可选配置把 `.dev.vars.example` 复制成 `.dev.vars` 即可。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 应用 + worker + 本地 D1 |
| `npm run check` | 类型检查、构建、`wrangler deploy --dry-run` |
| `npm test` | 单元测试（vitest） |
| `npm run deploy` | 手动部署 |
| `npm run smoke -- <url>` | 对某个部署做冒烟测试 |

### 部署你自己的一份

每次推送到 `main`，Cloudflare Workers Builds 都会执行构建（`npm run build`）与部署
（`npx wrangler deploy`）。fork 之后需要在 `wrangler.jsonc` 里换成你自己的资源：

- 一个 D1 数据库 —— `npx wrangler d1 create <name>`，把返回的 `database_id` 填进去；
- 两个用于存放上传文档的 R2 bucket：生产的和 `-dev` 的。不配也能跑，文本文件照常可以作为
  提示词材料加入，只有二进制文件会被拒绝，并给出说明；
- `routes` 配置块，它当前指向 `ctrl-y.manyfold.ai`。改成你自己的域名，或者删掉它并把
  `workers_dev` 设为 `true`。

然后按需设置 secrets：

```bash
npx wrangler secret put ADMIN_PASSWORD          # 建议设置：否则拿到 URL 的人都能调用你的 agent，并产生费用
npx wrangler secret put CONFIG_ENCRYPTION_KEY   # 可选：让加密密钥不落在数据库里
npx wrangler secret put R2_ACCESS_KEY_ID        # 与 R2_ACCOUNT_ID、R2_SECRET_ACCESS_KEY 一起，用于上传
```

部署后用 `npm run smoke -- <url>` 或 `GET /api/health` 验证。

## 技术构成

浏览器侧是 Vite + React 19，服务端是跑在单个 Cloudflare Worker 上的 Hono，状态存 D1，文档存
R2，通过 A2A 协议调用 Manyfold agents。

| 文件 | 作用 |
| --- | --- |
| `src/worker/panel.ts` | 跑一轮：先是各个评审 agent，然后是汇总 agent |
| `src/worker/routes.ts` | API —— 评审、问题、人、记忆、文档 |
| `src/worker/store.ts` | 这些路由背后所有的 D1 读写 |
| `src/worker/connect.ts` | Manyfold 授权握手与已连接 agent 的存储 |
| `src/app/views/` | 各个页面 |

Agent token 以 AES-GCM 加密存在 D1 中，永不进入浏览器；连通性检查使用不计费的探测；agent 提供的
URL 在使用前会被校验。`AGENTS.md` 列出了迭代时必须守住的约束，`PRODUCT.md` 说明这个产品为何
存在，`DESIGN.md` 说明它应该长什么样。

## 许可证

[MIT](LICENSE)

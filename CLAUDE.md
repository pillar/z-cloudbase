# z-cloudbase — 项目说明

开源（Apache-2.0）、可自部署的多产品共享基础后端，基于 Cloudflare：每个部署是一个平台账号体系加上多个产品，平台提供 Auth / SSO、Storage、Logs、Analytics、控制台和 SDK。类似 WordPress：运营者把它部署到自己的 Cloudflare 账号，部署时设置平台名称。**唯一需求来源**是 `z-cloudbase-prd-v3.0.md`（v3.0 的改动见 §20 和文中的 v3.0 标注）。

## 授权边界

- 允许：本地开发与测试（Miniflare 本地模拟 D1 / R2 / Queues，`--local`），以及 `pnpm platform:deploy --dry-run`（只在本地生成配置并构建）。
- 不允许，需另行获得用户确认：创建或修改 Cloudflare 远程资源、真实部署（`pnpm platform:deploy`、`wrangler deploy`）、`wrangler login` / `cf auth login`、申请或配置真实的 Google / Apple / 邮件 / Turnstile 凭据、推送或发布到 GitHub / npm。本地命令失败时，**不得自动改用远程模式**。
- 密钥、token、`.dev.vars` / `.env`、`.deploy/`、`wrangler.*.deploy.jsonc` 一律不进版本控制、日志或文档。

## 架构硬约束

- 用户属于平台（全局 `user_id`）；产品是授权和数据隔离的边界。每个产品环境有独立的 audience（`aud = urn:platform:{product_id}.{env}`）、membership、R2 前缀和分析标签。
- `product_id` / `env` / `user_id` 只能从凭证和已验证的 token 派生，**不得取自请求体**。
- A 产品的 token 访问 B 产品必须返回 401/403，且不泄露信息。每个新增路由都要有跨产品越权测试。
- 禁止自创 OAuth / OIDC 协议或密码哈希；使用认证引擎（Better Auth，见 PRD §19.1）。任何账号合并都不能基于邮箱相同；初始化接口也不得按邮箱提升已有账号。
- 平台不管理产品的业务表；`database/migrations` 只放平台元数据。
- 代码、协议标识和默认配置里不得出现任何具体部署的品牌、域名、账号 ID：显示名来自 `PLATFORM_NAME`（identity）/ `VITE_PLATFORM_NAME`（控制台），资源名来自部署前缀。
- 默认值、限额、错误码以 PRD §19 为准。要改就先改 PRD，再改代码。

## 结构

```text
services/identity   OIDC issuer + 登录/绑定 UI（Hono）+ 运营初始化接口 /setup/*
services/api        /v1/*：me、storage、logs、events、admin
services/consumer   Queues 消费 + Cron
apps/console        React + Vite 管理控制台
packages/contracts  Zod schema、错误码、OpenAPI
packages/security   JWT 校验、RBAC、凭证解析、脱敏
packages/sdk-web    @z-cloudbase/web
packages/sdk-server @z-cloudbase/server
packages/testing    Mock OIDC Provider、测试夹具
database/migrations 平台 D1 迁移（Drizzle）
scripts/            运营脚本（platform-deploy、platform-destroy、platform-reset-admin、dev、build-sdk）；scripts/test 用 node --test
tests/e2e           跨 Worker 端到端、越权测试
```

## 工具链

- 已验证版本：Node v24、pnpm 12.10.1、TypeScript 7.0.2、wrangler 4.148、vitest 4.1.x（`@cloudflare/vitest-plugin` 1.3.7 要求 vitest ^4.1，**不要升级到 vitest 5**）、hono 4.13、zod 4.6、jose 6.2。
- **Worker 配置使用 `wrangler.jsonc`，不使用 `cf` 的 `cloudflare.config.ts`**：`@cloudflare/vitest-plugin` 只读取 `wrangler.configPath`；两套配置并存会让绑定漂移。将来迁移到 `cf` 时先按 `~/.codex/cloudflare-cf-usage.md` §7 执行 `cf migrate --dry-run`。
- 仓库里的 `wrangler.jsonc` 只有本地值（`z-cloudbase-*` 名称、占位 `database_id`）。部署配置由 `scripts/platform-deploy.ts` 生成为同目录的 `wrangler.<prefix>.deploy.jsonc`（gitignored）：按前缀改写资源名，填入真实 D1 id、URL 和 vars，去掉 `dev` 与 `secrets` 段。新增绑定时，确认生成逻辑（`rename` 映射、`resourceNames`）覆盖到它，并用 `--dry-run` 检查。
- 默认值：部署前缀 `z-cloudbase`（与本地资源名相同，生成逻辑以 `resourceNames('z-cloudbase')` 为改写基准），平台显示名 `z-cloudbase`（`services/identity/src/platform.ts`、`apps/console/src/brand.ts`、`platform-deploy.ts` 三处一致）。
- identity 的 `secrets.required` 同时决定 `wrangler dev` 在本地加载哪些 secret（声明了 `secrets` 块后只加载列出的名字），所以 `SETUP_TOKEN` 也列在其中。
- consumer 按队列名后缀（`-logs` / `-events` / `-dlq`）路由，与前缀无关。
- 部署顺序：identity → consumer → api（api / consumer 通过服务绑定依赖 identity）→ console。identity 的 `AUTH_SECRET` 只在 Worker 不存在时生成，**绝不能覆盖**（会让全部会话失效、签名私钥无法解密）。

### 命令（均在仓库根目录执行）

```sh
pnpm install
pnpm -r typecheck                       # 全部包；Worker 包会先执行 wrangler types
pnpm -r test                            # 全部测试（packages 在 Node 中运行，services 在 workerd 中运行）
pnpm --filter @z-cloudbase/api test   # 单个包
pnpm --filter @z-cloudbase/api exec vitest run test/foo.test.ts   # 单个文件
pnpm --filter @z-cloudbase/api dev    # 单个 Worker 的本地 wrangler dev（identity 8787 / api 8788 / consumer 8789）
pnpm test:e2e                           # 三个 Worker 在同一个本地进程中运行的端到端测试（约 75 秒，每次使用全新临时状态）
pnpm dev                                # 本地栈 + 控制台一条命令（状态 .wrangler-state，端口 8787 / 5173，Ctrl-C 停止；首次打印管理员密码）
pnpm test:scripts                       # scripts/test 的 node:test（destroy 计划与确认、限流命名空间；用假的 wrangler runner，不访问远程）
pnpm bootstrap:local --persist-to .wrangler-state [--admin-email a@b.c]   # 本地迁移 + 控制台 client + 第一个管理员（随机密码，打印一次）
pnpm platform:deploy --dry-run [--prefix x --name "Y" --domain z.com]    # 只生成部署配置并构建，不访问远程
pnpm platform:deploy --admin-email <email> [...]   # 真实部署（远程，需用户授权）
pnpm platform:reset-admin --email <email> [--disable-2fa]   # 管理员找回密码（远程，需用户授权）
pnpm platform:destroy --prefix <p> --dry-run   # 打印删除计划（本地）；真实删除需要 --confirm <p> 或交互输入，属远程操作，需用户授权
pnpm sdk:pack                           # 构建可分发的 SDK：dist-sdk/z-cloudbase-web-<v>.tgz、z-cloudbase-server-<v>.tgz
```

- 本地多 Worker 运行方式（gateway、通过进程环境传变量、Local Explorer 触发 cron）见 `database/seeds/README.md`。存在 `services/*/.dev.vars` 时，本地 stack 会拒绝启动。
- 验收矩阵见 `docs/poc-acceptance.md`；认证引擎的结论见 `docs/spikes/auth-engine.md`；产品接入见 `docs/integration-guide.md`。
- 入口模块（`services/*/src/index.ts`）只能导出入口类和 default handler：workerd 会把每个具名导出都当作入口点，多导出会导致多 Worker 运行时无法启动。
- 运营脚本（`scripts/*.ts`、`tests/e2e/local-stack/*.ts`）由 Node 直接执行（类型剥离）：不能用构造函数参数属性、enum 等需要编译的 TS 语法。

- Worker 测试：`exports.default.fetch()`（来自 `cloudflare:workers`）用于集成测试；D1 迁移由 `test/apply-migrations.ts` 在每个测试文件开始前应用。api / consumer 测试中，`IDENTITY` 通过 `app.request(path, init, { ...env, IDENTITY: stub })` 注入；identity 测试用 `useEnv({ VAR: '…' })`（`test/helpers.ts`）覆盖部署变量。**不要用 `vi.mock` 替换 Worker 入口依赖图中的模块**：入口加载时这些模块已经载入，mock 不会生效。token 用 `@z-cloudbase/testing` 的 `createTestTokenMinter()` 签发。
- `worker-configuration.d.ts` 是生成文件（已加入 gitignore），由 `wrangler types` 生成。
- 迁移编号分段，避免并行冲突：`0001` 平台元数据，`0002` 认证引擎，`0010–0019` identity，`0020–0029` api/storage，`0030–0039` consumer/ingest，`0040–0049` admin。ingest 库的迁移放在 `database/ingest-migrations`。

## 控制台（apps/console）约定

- UI：shadcn/ui（new-york，zinc + indigo 主题）+ Tailwind v4；组件在 `src/components/ui/`，由 CLI 生成：在 apps/console 执行 `pnpm dlx shadcn@4.21.4 add <name> --yes`，**之后把生成文件里的 `from "cn"` 改为 `from "@/lib/utils"`**（CLI 写错了 import），`next-themes` 改为 `@/theme`。
- 页面只组合 `src/ui.tsx` 的共享部件（Section、StatusBadge、EnvBadge、CopyText、OneTimeSecret、useConfirm、EmptyState、Loading）和 shadcn 组件，不写裸 HTML 样式；不用 `window.confirm`。
- 文案：中英双语，默认中文。每个页面在文件顶部用 `defineMessages({ zh, en })` 定义自己的文案（编译器检查两种语言的 key 一致），通用词用 `common`；时间 / 数字 / 字节用 `useFormat()`。服务端错误信息原样显示。平台显示名只用 `src/brand.ts` 的 `PLATFORM_NAME`。
- 产品分区的导航与标题由 `shell.tsx` / `ProductDetail.tsx` 负责（`SECTIONS` 注册表），分区页面不重复产品标题。
- 分区页面是懒加载分块（`ProductDetail.tsx` 的 `lazyNamed`），`vite.config.ts` 的 `optimizeDeps.entries` 让开发服务器启动时预构建它们的依赖，否则首次打开某页会触发整页重载。
- 部署：由 `pnpm platform:deploy` 用部署的 `VITE_*` 构建后以 Workers Static Assets 发布。

## SDK 分发

- `@z-cloudbase/web` / `@z-cloudbase/server` 在仓库内导出 TS 源码；对外分发用 `pnpm sdk:pack`（`scripts/build-sdk.mjs`：esbuild 打包并内联 contracts/security，tsc 生成类型，`publishConfig` 生成干净的 package.json）。npm scope `@z-cloudbase` 尚未在 npm 注册，发布前确认可用。
- Web SDK 的浏览器包不得引入 zod（构建脚本会检查）：SDK 运行时只能从 contracts 中不依赖 zod 的模块（`ids.ts`、`limits.ts`、`errors.ts`）取常量。
- 改了 SDK 的公开 API 或行为，同步更新 `docs/integration-guide.md`，并升 `version`。

## 工作约定

- 改动前先读相关代码和 PRD 对应章节；契约变更（`packages/contracts`）要同步更新调用方和 SDK。
- 测试验证行为，不复述实现。认证和隔离类测试优先写端到端用例。
- 依赖本地替身的能力（Mock OIDC、R2 本地上传路由、AE 的 D1 替身），以及部署脚本的远程步骤，在验收矩阵中标为“本地已验证 / 远程待验证”，不得宣称生产路径已验证。
- 存在 `CORRECTIONS.md` 时，修改模块前先按模块名搜索其中的记录。

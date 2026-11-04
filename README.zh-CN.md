# z-cloudbase

[English](README.md)

基于 Cloudflare（Workers、D1、R2、Queues、Analytics Engine）的**可自部署多产品共享后端**：一套账号体系，承载多个产品。和 WordPress 一样，软件开源，每个运营者把它部署到自己的 Cloudflare 账号，并使用自己的平台名称。

一个部署提供：

- **所有产品共用一个账号**：全局 `user_id`，产品之间单点登录（标准 OIDC 授权码 + PKCE）。支持邮箱密码和游客（匿名）账号，游客以后可以升级为正式账号；Google / Apple 登录可选。
- **产品是隔离边界**：每个产品有 `dev` / `staging` / `prod` 三套环境，各自独立的 audience、密钥、成员关系、存储前缀和分析数据。A 产品的 token 访问 B 产品会被拒绝。
- **文件存储**（用户私有文件，R2 预签名直传）、**日志**、**埋点分析**。
- **管理控制台**（产品、环境、密钥、团队角色、用户、日志、分析、审计）和 **SDK**：浏览器端 `@z-cloudbase/web`，服务端 `@z-cloudbase/server`。
- **用户管理与产品 Webhook**：平台级封禁、有时限且全程审计的代登录（token 带 RFC 8693 `act` 声明）、按环境导出用户 CSV，以及带签名（[Standard Webhooks](https://www.standardwebhooks.com/)）的用户事件推送（首次进入、游客升级、删除、封禁 / 解封），含重试与投递记录。

刻意不做的：不托管数据库。产品自己管理业务库，用平台的 `user_id` 做外键。

## 部署

需要：一个 Cloudflare 账号，Node.js ≥ 22.18，pnpm 12。

```sh
git clone <本仓库> && cd z-cloudbase
pnpm install
pnpm exec wrangler login            # 或 export CLOUDFLARE_API_TOKEN=…

pnpm platform:deploy --admin-email you@example.com --name "我的平台"
# 使用自己的域名（该 zone 需在同一账号下）：加 --domain example.com
#   → https://id.example.com、https://api.example.com、https://console.example.com
# 不加 --domain 时使用 <名称>.<你的子域>.workers.dev
```

脚本会依次完成：

1. 创建缺少的 D1、R2、Queues，并执行迁移；
2. 部署三个 Worker 和控制台；
3. 注册控制台。

首次运行时还会创建管理员，**密码随机生成，只显示这一次**：

```text
Administrator (the password is shown only now — store it in a password manager):
  email     you@example.com
  password  k7Qm…（24 位）
```

打开控制台地址登录，就可以创建第一个产品。想先看看效果、不动账号里的任何东西，可以用 `pnpm platform:deploy --dry-run`：它只在本地生成配置并构建所有 Worker。

没有“Deploy to Cloudflare”一键按钮：它每个按钮只部署一个 Worker，无法配置服务绑定、Analytics Engine 和首个管理员（依据见 PRD §21.1）。

### 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--admin-email` | （交互询问） | 第一个管理员，首次部署必填 |
| `--name` | `z-cloudbase` | 平台显示名：登录页、邮件、TOTP 发行方、控制台 |
| `--domain` | workers.dev | 使用该域名下的 `id.` / `api.` / `console.` 子域 |
| `--prefix` | `z-cloudbase` | 资源名前缀；同一账号部署多套平台时用不同前缀 |
| `--require-admin-2fa` | `false` | `true` 表示管理员使用控制台前必须通过第二因素（TOTP，或用 Passkey 登录） |
| `--signup-mode` | `open` | `open`：任何人可注册；`invite`：只能凭控制台“邀请”页发出的邀请注册；`closed`：不再创建账号。非 `open` 时游客和新的 Google / Apple / Magic link 用户也被拒绝 |
| `--require-email-verification` | `true` | `false` 允许未验证邮箱的用户用密码登录（没有邮件时接受邮箱注册的唯一方式；此时任何人都能用别人的邮箱注册，`email_verified` 为 `false`） |
| `--default-lang` | `en` | 浏览器既不要求 `zh` 也不要求 `en` 时登录页和邮件的语言 |
| `--passkeys` / `--magic-link` | `true` | Passkey 登录；邮件登录链接（只在配置了邮件时出现） |
| `--logo-url` | | 登录页、邮件和控制台使用的 `https://` logo |
| `--primary-color` | 靛蓝 | 登录页、邮件链接和控制台的主色（`#4f46e5`） |
| `--tagline` | | 登录页标题下的一行文案（≤ 200 字符） |
| `--account-id` | 唯一的账号 | 登录身份下有多个账号时指定 |
| `--location` | 自动 | D1 / R2 位置提示（`weur`、`enam` 等） |
| `--dry-run` | | 只生成配置并构建，不创建、不上传 |

### 可选集成

在执行部署命令的环境变量里设置以下值：密钥作为 Worker secret 上传，其余邮件设置保存在 `.deploy/<prefix>.json`。之后的部署没有再设置时，保留已有的值。部署结束时会列出仍未配置的项。

| 环境变量 | 开启的能力 | 不配置时 |
|---|---|---|
| `EMAIL_FROM` + 一种发送方式：`RESEND_API_KEY`（[Resend](https://resend.com)），或 `EMAIL_TRANSPORT=smtp` + `SMTP_HOST` [`SMTP_PORT`=465、`SMTP_USERNAME`、`SMTP_PASSWORD`]，或 `EMAIL_TRANSPORT=cloudflare` | 验证、找回密码、登录链接和邀请邮件。SMTP 在 Workers Free 可用（只支持隐式 TLS，不支持 STARTTLS 和 25 端口）；Cloudflare Email Service 需要 Workers Paid 且发件域名已接入 | 默认要求邮箱验证时：无法用邮箱密码注册、找回密码或使用登录链接（游客、社交登录和管理员不受影响） |
| `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` | 3 次登录失败后出现人机验证 | 只有登录限流 |
| `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` | 文件上传 / 下载（R2 S3 预签名；需要对 `<prefix>-storage` 有对象读写权限的 R2 API token） | 存储接口返回 `unavailable` |
| `CF_ANALYTICS_API_TOKEN` | 控制台分析图表（Account Analytics: Read） | 事件照常采集，但无法查询 |
| `GOOGLE_CLIENT_ID/SECRET`、`APPLE_CLIENT_ID/SECRET` | 第三方登录 | 不提供 |

### 升级

```sh
git pull && pnpm install
pnpm platform:deploy             # 首次部署的设置保存在 .deploy/<prefix>.json
```

升级时，在对已有数据库应用迁移之前，脚本会把每个 D1 数据库当前的 Time Travel bookmark 记录到 `.deploy/<prefix>.json`，并打印 `wrangler d1 time-travel restore …` 回滚命令（迁移失败时也会打印）。记录里还保存已部署的 `version` 和 git `commit`。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

### 删除部署

```sh
pnpm platform:destroy --prefix <prefix> --dry-run    # 只打印计划
pnpm platform:destroy --prefix <prefix>              # 要求输入前缀确认（非交互环境：--confirm <prefix>）
```

删除该前缀的 Worker（含自定义域名）、队列消费者与队列、两个 D1 数据库、两个 R2 bucket，最后删除 `.deploy/<prefix>.json`。wrangler 无法清空 R2 bucket：非空的 bucket 会被加上“1 天后过期全部对象”的生命周期规则，约 24 小时后重新执行同一条命令即可。Analytics Engine 数据集无法删除。D1 删除不可恢复。

### 管理员

- 更多管理员和产品角色（`owner`、`operator`、`product_admin`、`product_developer`）在控制台的“团队”页管理。
- TOTP 默认可选，管理员可以在身份域的 `/account` 页面开启。开启后，每次登录控制台都要输入验证码。在 `/account` 添加的 Passkey 也算：用它登录即满足控制台的第二因素要求。
- `--signup-mode invite` 时，所有者在控制台“邀请”页邀请用户；邀请链接发到受邀邮箱（没有配置邮件时只显示一次）。
- 忘记密码或丢失认证器（不需要邮件服务）：

  ```sh
  pnpm platform:reset-admin --email you@example.com [--disable-2fa]
  ```

  脚本会给 identity Worker 写入一个新的一次性初始化 token（以你的 Cloudflare 登录为准），然后设置新的随机密码、只打印一次，并让该管理员所有已登录的会话下线。`--disable-2fa` 会同时移除 TOTP 和 Passkey。

平台没有网页安装向导，也没有公开的管理员注册入口：只有能部署到这个 Cloudflare 账号的人，才能创建第一个管理员。

## 产品接入

1. 在控制台创建产品，填写回调地址和允许的来源，复制可发布密钥（`pk_dev_…`）；有后端时再创建服务密钥。
2. 从 npm 安装 SDK：`npm i @z-cloudbase/web`（前端）、`npm i @z-cloudbase/server`（后端）。如果你的部署改过 SDK，改用 tgz 包：`pnpm sdk:pack` → `dist-sdk/z-cloudbase-web-<v>.tgz`、`z-cloudbase-server-<v>.tgz`。
3. 按接入教程操作：[中文](docs/integration-guide.md) 或 [English](docs/integration-guide.en.md)（AI 编程助手可以按步骤执行）。

## 开发

```sh
pnpm -r typecheck
pnpm -r test                     # 单元测试 + workerd 集成测试
pnpm test:e2e                    # 所有 Worker 跑在一个本地进程里（约 75 秒，每次使用全新状态）
pnpm dev                         # 本地栈 + 控制台，状态持久化；首次运行打印一次管理员密码
pnpm test:scripts                # 运营脚本测试
pnpm bootstrap:local --persist-to .wrangler-state   # 本地状态 + 随机密码的管理员（不保持服务运行）
```

`pnpm dev` 在 http://localhost:8787 启动 identity / api / consumer，在 http://localhost:5173 启动控制台（状态在 gitignore 的 `.wrangler-state/`，Ctrl-C 停止全部）。贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全策略见 [SECURITY.md](SECURITY.md)。

全部在本地 Miniflare 上运行，测试不会访问 Cloudflare 账号。约定见 [CLAUDE.md](CLAUDE.md)，本地栈说明见 [database/seeds/README.md](database/seeds/README.md)，需求与规格见 [PRD v3.0](z-cloudbase-prd-v3.0.md)。

## 发版

SDK 由 `.github/workflows/release.yml` 通过 npm trusted publisher（GitHub OIDC，无 token）发布到 npm。trusted publisher 只能把版本放进**暂存区**，由维护者用两步验证正式发布。

1. 修改 `package.json`、`packages/sdk-web/package.json`、`packages/sdk-server/package.json` 的 `version`（三者必须一致），把 CHANGELOG `Unreleased` 下的条目移到新版本下，跑完上面的检查后提交。
2. `git tag -a vX.Y.Z -m "z-cloudbase X.Y.Z"`，然后 `git push origin main`、`git push origin vX.Y.Z`。
3. workflow 校验 tag 与版本一致，跑类型检查和测试，打包，把两个包连同 provenance 暂存到 npm，并创建附带 tgz 的 GitHub Release。
4. 等 npm 自动审查结束：`npm stage view <id>`（id 在 workflow 日志里）从 `validating` 变为 `staged`。
5. 逐个正式发布：`npm stage approve <id> --otp=<验证码>`（用安全密钥或 Passkey 时去掉 `--otp`，在浏览器里确认）。检查：`npm view @z-cloudbase/web dist-tags.latest`。

如果 workflow 在暂存之前就失败，在 `main` 上修复后移动 tag（`git push origin :refs/tags/vX.Y.Z`、`git tag -f -a vX.Y.Z …`、`git push origin vX.Y.Z`）；已暂存或已发布过的版本号不能再用，改发下一个补丁版本。不要的暂存版本用 `npm stage reject <id>` 删除。

## 状态

早期版本。这套 Worker 在开源之前曾部署到 Cloudflare 验证过：SSO、跨产品隔离、R2 预签名、Analytics Engine、Turnstile、Resend、控制台。自部署脚本、初始化接口和可配置名称已经有本地测试和 dry-run 覆盖，但**本仓库还没有真实执行过 `pnpm platform:deploy`**。Google / Apple 登录只用 Mock Provider 测试过。已验证与未验证的事项见 [docs/poc-acceptance.md](docs/poc-acceptance.md)。

## 许可证

[Apache-2.0](LICENSE)

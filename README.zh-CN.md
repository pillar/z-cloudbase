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

### 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--admin-email` | （交互询问） | 第一个管理员，首次部署必填 |
| `--name` | `z-cloudbase` | 平台显示名：登录页、邮件、TOTP 发行方、控制台 |
| `--domain` | workers.dev | 使用该域名下的 `id.` / `api.` / `console.` 子域 |
| `--prefix` | `z-cloudbase` | 资源名前缀；同一账号部署多套平台时用不同前缀 |
| `--require-admin-2fa` | `false` | `true` 表示管理员必须先绑定 TOTP 才能使用控制台 |
| `--account-id` | 唯一的账号 | 登录身份下有多个账号时指定 |
| `--location` | 自动 | D1 / R2 位置提示（`weur`、`enam` 等） |
| `--dry-run` | | 只生成配置并构建，不创建、不上传 |

### 可选集成

在执行部署命令的环境变量里设置以下值，会作为 Worker secret 上传。之后的部署没有再设置时，保留已有的值。部署结束时会列出仍未配置的项。

| 环境变量 | 开启的能力 | 不配置时 |
|---|---|---|
| `RESEND_API_KEY` + `EMAIL_FROM` | 验证邮件与找回密码邮件（[Resend](https://resend.com)） | 用户无法用邮箱密码注册或找回密码（游客和管理员不受影响） |
| `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` | 3 次登录失败后出现人机验证 | 只有登录限流 |
| `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` | 文件上传 / 下载（R2 S3 预签名；需要对 `<prefix>-storage` 有对象读写权限的 R2 API token） | 存储接口返回 `unavailable` |
| `CF_ANALYTICS_API_TOKEN` | 控制台分析图表（Account Analytics: Read） | 事件照常采集，但无法查询 |
| `GOOGLE_CLIENT_ID/SECRET`、`APPLE_CLIENT_ID/SECRET` | 第三方登录 | 不提供 |

### 升级

```sh
git pull && pnpm install
pnpm platform:deploy             # 首次部署的设置保存在 .deploy/<prefix>.json
```

### 管理员

- 更多管理员和产品角色（`owner`、`operator`、`product_admin`、`product_developer`）在控制台的“团队”页管理。
- TOTP 默认可选，管理员可以在身份域的 `/account` 页面开启。开启后，每次登录控制台都要输入验证码。
- 忘记密码或丢失认证器（不需要邮件服务）：

  ```sh
  pnpm platform:reset-admin --email you@example.com [--disable-2fa]
  ```

  脚本会给 identity Worker 写入一个新的一次性初始化 token（以你的 Cloudflare 登录为准），然后设置新的随机密码、只打印一次，并让该管理员所有已登录的会话下线。

平台没有网页安装向导，也没有公开的管理员注册入口：只有能部署到这个 Cloudflare 账号的人，才能创建第一个管理员。

## 产品接入

1. 在控制台创建产品，填写回调地址和允许的来源，复制可发布密钥（`pk_dev_…`）；有后端时再创建服务密钥。
2. 构建 SDK 包：`pnpm sdk:pack` → `dist-sdk/z-cloudbase-web-<v>.tgz`、`z-cloudbase-server-<v>.tgz`（尚未发布到 npm）。
3. 按 [docs/integration-guide.md](docs/integration-guide.md) 接入（AI 编程助手可以按步骤执行）。

## 开发

```sh
pnpm -r typecheck
pnpm -r test                     # 单元测试 + workerd 集成测试
pnpm test:e2e                    # 所有 Worker 跑在一个本地进程里（约 75 秒，每次使用全新状态）
pnpm bootstrap:local --persist-to .wrangler-state   # 本地状态 + 随机密码的管理员
```

全部在本地 Miniflare 上运行，测试不会访问 Cloudflare 账号。约定见 [CLAUDE.md](CLAUDE.md)，本地栈说明见 [database/seeds/README.md](database/seeds/README.md)，需求与规格见 [PRD v3.0](z-cloudbase-prd-v3.0.md)。

## 状态

早期版本。这套 Worker 在开源之前曾部署到 Cloudflare 验证过：SSO、跨产品隔离、R2 预签名、Analytics Engine、Turnstile、Resend、控制台。自部署脚本、初始化接口和可配置名称已经有本地测试和 dry-run 覆盖，但**本仓库还没有真实执行过 `pnpm platform:deploy`**。Google / Apple 登录只用 Mock Provider 测试过。已验证与未验证的事项见 [docs/poc-acceptance.md](docs/poc-acceptance.md)。

## 许可证

[Apache-2.0](LICENSE)

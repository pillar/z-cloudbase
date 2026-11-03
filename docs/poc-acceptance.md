# 验收矩阵（PRD §15，本地）

## 运行环境与证据来源

| 项 | 值 |
|---|---|
| 被测代码 | 本仓库首个提交（由私有 POC 派生、去品牌化并加入自部署后的代码） |
| 日期 | 2026-11-03 |
| Node / pnpm | v24 / 12.10.1 |
| wrangler / workerd | 4.148.0 / 1.20261006.1 |
| vitest | 4.1.11 |
| 运行范围 | 仅本地。未执行任何 `wrangler deploy`、`--remote`、登录或真实 Provider 调用；`pnpm platform:deploy --dry-run` 只在本地生成配置并构建 |

| 命令 | 实测结果 |
|---|---|
| `pnpm -r typecheck` | 全部包通过 |
| `pnpm -r test` | 601 个用例全部通过（identity 163、api 222、consumer 38、sdk-web 88、sdk-server 51、console 23、security 13、contracts 3） |
| `pnpm test:e2e` | `Test Files 7 passed (7)`，`Tests 38 passed (38)`，约 77 s，从全新临时状态运行；owner 由 `/setup/install` 以随机密码创建 |
| `pnpm platform:deploy --dry-run`（workers.dev 与 `--domain` 两种） | 生成 4 份部署配置，4 个 Worker 均通过 `wrangler deploy --dry-run` 构建，绑定名按前缀改写 |
| `pnpm bootstrap:local`（同一状态目录运行两次） | 第一次创建管理员并打印随机密码；第二次提示已存在、不改动 |

### e2e 的运行方式（`tests/e2e`）

- globalSetup 新建临时目录（`$TMPDIR/z-cloudbase-e2e-*`，结束后删除；`E2E_KEEP_STATE=1` 时保留以便排查），执行两套 D1 迁移，然后在**一个** `wrangler dev` 进程里启动全部 Worker，再调用 identity 的 `/setup/install`（与 `pnpm platform:deploy` 同一路径）注册控制台 client 并创建 owner：`wrangler dev -c tests/e2e/local-stack/gateway/wrangler.jsonc -c services/identity/wrangler.jsonc -c services/api/wrangler.jsonc -c services/consumer/wrangler.jsonc --persist-to <tmp>`。D1、R2、`IDENTITY`/`IdentityRpc` 服务绑定、api → consumer 队列及其 DLQ 都在同一个 Miniflare 实例内，均已在用例中实际走通。
- 与任务给定命令的差异及原因：多配置 `wrangler dev` 只把**第一个**配置暴露在 HTTP 上，其余只能经服务绑定访问（官方 multi-workers 文档）。因此第一个配置是只在本地使用的 gateway：`http://localhost:<port>` 转发给 identity（`ISSUER`），`http://127.0.0.1:<port>` 转发给 api（`API_ORIGIN`）。`--var` 也只作用于第一个配置，所以 `ISSUER`、`API_ORIGIN`、启动时随机生成的 `AUTH_SECRET`、`UPLOAD_SIGNING_SECRET` 与 `SETUP_TOKEN` 通过进程环境传入（`CLOUDFLARE_INCLUDE_PROCESS_ENV=true`，其余环境变量被裁剪）；任何密钥都不写入仓库或 `.dev.vars`。
- `--test-scheduled` 的 `/__scheduled`（`/cdn-cgi/handler/scheduled`）只能触发第一个 Worker，无法触发 consumer。替代方案是 wrangler Local Explorer 的 `POST /cdn-cgi/local/explorer/api/local/scheduled?worker=z-cloudbase-consumer`，用例用它触发 cron；D1 查询（如读取本地 outbox）和 R2 列表也走 Local Explorer。实测：另一个进程（`wrangler d1 execute`）对运行中实例的写入不会被看到，所以迁移只在启动前执行，运行期的写入都走 Local Explorer。
- “浏览器”是 Node 中的模拟：按主机保存 Cookie、手动跟随重定向、以本域 Origin 提交表单，跨域 `fetch` 带 Origin 并按浏览器规则做预检与 CORS 校验，Web SDK 读取的 `location` / `sessionStorage` / `localStorage` 由垫片替换。Web SDK（`@z-cloudbase/web`）和 Server SDK（`@z-cloudbase/server`）都是真实包，没有重写 SDK 逻辑。每个模拟浏览器使用独立的 `cf-connecting-ip`（只有本地允许客户端自带该头；生产环境由 Cloudflare 覆盖），使按 IP 的认证限流按“设备”计数。
- 只有无法通过 HTTP 快进的时间才直接修改 D1：会话 `createdAt`（验证再认证窗口）、`deletion_requests.due_at`（跳过 7 天冷静期）、`storage_objects.created_at`（让上传超过 TTL + 1 h）。DLQ 演练用 ingest D1 上的一个临时触发器注入存储故障，演练结束后删除。

## 验收矩阵

状态说明：**本地已验证** = 生产代码路径在本地真实运行；**本地 mock 已验证，远程待验证** = 依赖 PRD §19.10 的本地替身或 mock；**未覆盖** = 本地无法或尚未验证。

| # | PRD §15 条目 | 覆盖用例（文件 › 用例） | 观察结果 | 状态 |
|---|---|---|---|---|
| 1 | 新建 A、B，配置 prod，创建并分配管理员；B 管理员无法读取 A 私有数据 | `01-products-admin` › the owner creates products A and B…；assigns a product admin to each product…；B's admin sees only B and gets 403 on every A resource…；product mutations by admins are audited… | owner 通过 admin API 建出 A、B（dev/staging/prod 三套环境、publishable key、OIDC client），重复创建返回 409 `conflict`；B 管理员列表里只有 B，对 A 的 8 个读接口和 3 个写接口均返回 403，响应中不含 A 的名称 | 本地已验证 |
| 2 | U 只注册一次，先登录 A，再经 SSO 登录 B；全局 ID 一致，membership 独立 | `02-sso-accounts` › U signs up once, signs into A (password prompt), then into B without a second prompt… | 只出现一次登录页；Web SDK 在 A、B 拿到相同 `user_id`；`/v1/me` 只描述各自产品；A、B 两条 membership 都是 active；两个 token 的 `aud` 分别是各自 URN | 本地已验证 |
| 3 | Email / Password 注册、验证、重置与登录 | `02-sso-accounts` › verifies the address from the outbox link, resets the password…；does not reveal on sign-up whether an address is already registered；`03-tokens` › after a reset, the old identity session and the old product refresh token are dead | 表单注册 → outbox 验证链接 → `email_verified=true`；忘记密码页对已注册与未注册邮箱返回相同内容；重置后旧密码失败、新密码成功，重置链接只能用一次，旧会话失效 | 本地 mock 已验证，远程待验证（邮件走 D1 outbox 替身，真实邮件供应商未选定） |
| 4 | Google 和 Apple 完成真实授权回调验证；同一 provider subject 不重复建号 | 不在 e2e 中：Better Auth 1.7.7 的 Google / Apple 端点写死在代码里，`wrangler dev` 下无法指向 mock。参考 `services/identity/test/social.test.ts` › Google sign-in maps the same Google subject to the same user；Apple sign-in with a private-relay email via form_post creates one user…；provider id_token verification（14 个篡改 / nonce / aud / iss / 过期用例） | workerd 集成测试中用 mock IdP 拦截 fetch，全部通过 | 本地 mock 已验证 / 真实 Provider 待验证 |
| 5 | 匿名登录获得稳定会话与全局 ID；升级到 Email / Google / Apple 时保留身份及产品关联 | `02-sso-accounts` › an anonymous session gets a stable global id and product memberships; upgrading to Email keeps the id and memberships；`06-app-and-game` › web game: anonymous guest…；Google / Apple 升级：`services/identity/test/gate4-anonymous-link.test.ts` › links Google (mock IdP)…；`social.test.ts` › apple: an anonymous user links Apple in place… | 匿名用户 SSO 进入 A、B，token `anon=true`；`/link/email` 后 `user_id` 不变，两条 membership 保留，新 token `anon=false` | Email 升级：本地已验证；Google / Apple 升级：本地 mock 已验证 / 真实 Provider 待验证 |
| 6 | 已被他人绑定的凭据不自动合并；错误、取消授权、回调重放有可验证的拒绝结果 | `02-sso-accounts` › linking an email that belongs to another account is a 409 conflict and never merges either account；`03-tokens` › a replayed authorization code and a wrong code_verifier are refused with invalid_grant；Provider 冲突与错误：`gate4-anonymous-link.test.ts` › linking a Google identity owned by another user is a conflict…；`social.test.ts` › provider id_token verification；取消授权：`services/identity/test/ui.test.ts` › consent page: allow returns a code, deny returns access_denied | 409 `identity_conflict`，两个账号都不变，攻击者密码无法登录；授权码重放返回 400 `invalid_grant`；错误 verifier 被拒且该 code 随即作废 | Email 冲突与回调重放：本地已验证；Provider 冲突 / 错误 / 取消授权：本地 mock 已验证（workerd 集成测试） |
| 7 | A 的 access token 调用 B 的私有资源得到 401/403 且无信息泄露 | `02-sso-accounts` › is rejected with 401 at B's API without revealing anything about A or the user；`04-storage` › is invisible to the same person in product B… | 4 个 B 接口都返回 401 `invalid_token`，响应中不含 A 的产品 ID、用户 ID 和邮箱；即使用户在 B 有 membership，A 的 token 仍被拒；A 的 prod token 在 A 的 dev 环境同样被拒 | 本地已验证 |
| 8 | 密码重置、会话失效、refresh token 重放、密钥轮换与撤销 | `03-tokens` › rotates on every use; replaying a rotated token revokes the client family and writes a security audit row；the Web SDK restores a session from a persisted refresh token and rotates it（含 `signOut` 撤销）；after a reset, the old identity session and the old product refresh token are dead；密钥轮换：`services/identity/test/key-rotation.test.ts` › after rotation new tokens use a new kid and tokens of the old kid verify through the grace period | 每次 refresh 都换新 token；重放旧 token 返回 `invalid_grant`，同一 client 下仍有效的 token 也失效；审计中出现 `auth.refresh_token_reuse`（actor=system）；身份域会话保留（SSO 不受影响）；`signOut` 后 refresh token 失效 | 重置 / 会话 / 重放 / 撤销：本地已验证；密钥轮换：本地已验证（workerd 内伪造时间的集成测试；轮换周期 90 天，无法经 HTTP 演练） |
| 9 | A 上传私有文件成功，B 用户无法读取；到期 URL 拒绝；文件删除可审计 | `04-storage` › uploads through the signed local URL, completes and downloads the same bytes as the owner；is invisible to the same person in product B and to another user of A；refuses an expired download URL and a tampered one；deletes the object (R2 + row) and records it in the product audit trail；rejects an upload whose bytes do not match the declared image type；`stale pending uploads` › reclaims an upload that was never completed… | SDK 走完 create → PUT → complete → 下载，字节一致，R2 key 位于 `{product}/prod/{bucket}/` 下；B 用户和 A 的其他用户都得到 404；1 秒 TTL 的 URL 到期后、以及被篡改的 URL 都返回 404；删除后 R2 中无对象，审计有 `storage.object.delete`；超时未完成的上传由 cron 清理并写 `storage.pending_upload.reaped` | 本地 mock 已验证，远程待验证（本地签名路由代替 R2 S3 预签名） |
| 10 | 两产品各上传日志、浏览器错误、行为事件；后台严格隔离并能按环境筛选 | `05-logs-events` › server logs (Server SDK) are redacted, archived and found by request_id in their own product only；browser error reports (Web SDK) are found by the ingest request id…；Web SDK events of A show up in A's analytics summary only | Server SDK 日志经队列、consumer 写入 R2 归档和 `log_index`，按 `request_id` 在 A 查到 2 条，敏感字段为 `[REDACTED]`；在 B、A 的 dev 环境均查不到；B 管理员查询 A 返回 403；level 筛选有效；浏览器错误标记为 `source: browser`，消息里的 Bearer 已脱敏；事件只计入 A 的汇总，B 为 0，库中只有 HMAC `user_key` | 日志：本地已验证；事件分析：本地 mock 已验证，远程待验证（AE SQL 由 D1 替身代替，`source: d1_substitute`） |
| 11 | 事件重复提交符合去重语义；队列故障与 DLQ 恢复演练通过 | `05-logs-events` › a duplicated event_id is accepted once and counted once；unregistered event names are accepted with a warning outside prod；a message the consumer cannot store is retried, dead-lettered, persisted in the archive and replayed after the fault is fixed | 重复 `event_id` 第二次返回 `duplicate: 1`，汇总只计 1 次（超过一个批次窗口后复查）；同一 ID 在另一产品算作不同事件；注入故障后消息经 3 次重试进入 `z-cloudbase-events-dlq`，被持久化到 `dlq/z-cloudbase-events-dlq/{date}/`；移除故障后经 `ConsumerOps.replayDlq` 重放，事件入库、归档清空 | 本地已验证（Miniflare 本地队列的重试与 DLQ 路由），远程待验证 |
| 12 | 普通 Web App 与 Web Game 都可通过同一 SDK / HTTP API 运行；业务表无需向平台注册 | `06-app-and-game` › web app: email account, redirect sign-in, profile, file upload and page analytics；web game: anonymous guest, session kept across reloads, gameplay events and crash reports；neither product registered a table or an event schema with the platform | 两种配置使用同一个 `@z-cloudbase/web`；平台和 ingest D1 的表清单在前后完全一致；两个产品都没有注册事件 schema | 本地已验证 |
| 13 | 用户导出、删除申请可追踪，服务端实际清理有日志和验证结果 | `07-deletion-export` › product APIs offer no account deletion or export, whatever the token；data export: is requested on the identity domain, built by the cron and downloaded once per one-time link, by its owner only；account deletion: needs a recent sign-in, honours the cooldown, can be cancelled, and is executed by the cron once due；leaving one product: revokes the membership, and the cron deletes that product's files only… | 导出：在身份域发起 → cron → `completed`；导出 JSON 含身份、两条 membership 和对象清单，不含密码或哈希，只有本人能在身份域通过一次性链接下载（第二次使用、他人使用、经 api 域名访问均为 404；原直接下载路由已移除）。删除：会话超过 5 分钟返回 403 `reauth_required`，跨站提交返回 403；冷静期内 cron 不处理，可以撤回；到期后 cron 删除两个产品中的对象（R2 与数据行）和 membership，身份变为墓碑（无法登录，会话失效）；审计链完整（`account.deletion.request` / `cancel` / `delete.completed` / `auth.identity_deleted`）。退出产品只清理该产品的数据 | 本地已验证（cron 经 Local Explorer 手动触发；冷静期通过修改 `due_at` 快进） |
| 14 | 压测、成本警报、备份演练、最低安全基线 | — | — | 未覆盖（需要远程环境、预算与授权；本次只在本地实施） |

### 额外覆盖（与 §15 相关的 §19 规格）

| 规格 | 用例 | 状态 |
|---|---|---|
| §19.4 产品停用立即作用于 API、`/authorize` 与 refresh | `03-tokens` › blocks the API at once, refuses new authorizations and refreshes, and recovers when re-enabled | 本地已验证 |
| §19.6 认证限流（每 IP 10 次 / 分钟，429 + `Retry-After`） | `03-tokens` › answers 429 rate_limited with Retry-After after 10 sign-in attempts per IP per minute | 本地 mock 已验证，远程待验证（本地 Rate Limiting 模拟） |
| §19.6 / §19.11 Turnstile：同一账号或 IP 15 分钟内认证失败 3 次后，登录、注册、找回密码（两步）、`/link/email` 需要有效 token；计数只存 HMAC；登录成功清除账号计数 | e2e：`03-tokens` › after 3 failed sign-ins from a device its login form shows the widget and needs the token; solved, the SDK sign-in completes；an account that failed 3 times is challenged on every device。identity：`turnstile.test.ts`（14 个用例：阈值、缺失 / 伪造 token、邮箱大小写与尾斜杠绕过、JSON body 中的 token 不被读取、成功清除账号计数但不清 IP 计数、窗口过期、无效重置 token 计入 IP、只存 HMAC、表单页显示 widget、siteverify adapter） | 计数、拦截与页面：本地已验证（本地 verifier 只接受 Cloudflare 测试 dummy token，不访问网络）；**siteverify 生产路径远程待验证**（adapter 只用注入的 fetch 单测过） |
| §19.9 / §19.11 管理员 MFA：TOTP 默认可选；已开启 TOTP 的管理员在 `platform_console` 授权前必须在本次身份域会话通过第二因素；`REQUIRE_ADMIN_2FA=true` 时未注册者先到身份域注册页（备用码只显示一次）再恢复授权；产品 client 不受影响 | e2e：`01-products-admin` › console sign-in: the password is enough by default; once an admin enables TOTP the code is required（验证码按 RFC 6238 在测试中计算）。identity：`admin-mfa.test.ts` › default deployment: TOTP is optional for administrators；REQUIRE_ADMIN_2FA=true: console authorization requires TOTP（enrollment、with TOTP、backup code、step-up、product clients unaffected、resume only this issuer、disabling audited） | 本地已验证（Better Auth 1.7.7 two-factor 插件；只支持 TOTP + 备用码） |
| §19.8 / §19.11 一次性导出链接：15 分钟有效、只能用一次（条件 UPDATE 原子消费）、生成需 5 分钟内再认证、只存 token 的 SHA-256、生成与下载都写审计 | e2e：`07-deletion-export` › data export: is requested on the identity domain, built by the cron and downloaded once per one-time link, by its owner only。identity：`account-requests.test.ts` › downloads a completed export once through a 15-minute link…；refuses another user's link…；creating a link needs the owner and a recent sign-in…；concurrent downloads of one link: exactly one succeeds | 本地已验证 |
| §19.11 环境设置（总配额、单对象上限、MIME / 扩展名白名单、每日上传配额、unknown event 策略） | api：`admin-environments.test.ts`；console：`envSettings.test.ts` | 本地已验证（workerd 集成测试） |
| §19.11 每日上传配额（UTC 日；删除不退回额度；与总配额在同一条语句中判断，并发上传也不会超限）、扩展名白名单 | api：`storage-limits.test.ts` | 本地已验证（workerd 集成测试） |
| §19.11 事件属性 Schema（dev / staging 返回 warning，prod 拒绝 `schema_violation`；版本未登记按 unknown event 处理） | api：`event-validate.test.ts`（纯函数）、`events-schema.test.ts` | 本地已验证（workerd 集成测试） |
| §19.11 Web SDK 自动采集（page_view、session_start、30 分钟无活动轮换会话、默认关闭、可摇树） | sdk-web：`autocapture.test.ts` | 本地已验证（DOM / history 垫片） |
| §19.5 幂等键竞态（只有拿到占位才执行 handler） | api：`idempotency-race.test.ts`；已做反向验证（恢复旧逻辑后 2 个用例失败） | 本地已验证 |

## 自部署与管理员初始化（本仓库新增）

| 项目 | 证据 | 状态 |
|---|---|---|
| `/setup/install`：token 校验、短密码拒绝、不提升已有账号、创建已验证 owner、重复执行只更新控制台回调 | identity：`setup.test.ts` | 本地已验证 |
| `/setup/reset-admin`：新密码生效、旧密码失效、全部会话下线、可移除 TOTP、拒绝非团队成员 | identity：`setup.test.ts` | 本地已验证 |
| 管理员 TOTP 默认可选；已开启的管理员必须通过；`REQUIRE_ADMIN_2FA=true` 时强制注册 | identity：`admin-mfa.test.ts`；e2e：`01-products-admin` | 本地已验证 |
| 未配置 Turnstile 的部署不触发挑战（仍有限流） | identity：`turnstile.test.ts` | 本地已验证 |
| 平台名称可配置（登录页标题、邮件、TOTP issuer、控制台） | identity：`email-resend.test.ts`；控制台构建产物标题 | 本地已验证 |
| `pnpm platform:deploy` 真实部署（建资源、迁移、secrets、custom domain / workers.dev、install） | 无 | **远程未验证** |
| `pnpm platform:reset-admin`（`wrangler secret put` 后调用） | 无 | **远程未验证** |

## v3.1：邮件、注册模式、Passkey、Magic link、品牌与多语言（PRD §21.2–21.4）

| 项目 | 证据 | 状态 |
|---|---|---|
| SMTP 发信（worker-mailer，`cloudflare:sockets`）：AUTH、MAIL / RCPT / DATA、错误不含收件人和服务器原文 | identity：`email-transports.test.ts`（Node 中的假 SMTP 对端，明文 TCP） | 本地协议边界已验证；隐式 TLS 握手与真实投递**远程未验证** |
| Cloudflare Email Service（`send_email` 绑定） | identity：`email-transports.test.ts`（假绑定）；`platform:deploy --dry-run` 生成 `SEND_EMAIL` 绑定 | 本地已验证（假绑定）；真实发送需 Workers Paid，**远程未验证** |
| 注册模式 open / invite / closed、邮箱验证开关、无邮件时的降级 | identity：`signup-modes.test.ts` | 本地已验证 |
| 邀请：只用一次、过期 / 撤销 / 未知链接一致拒绝、邮件送达时视为已验证、审计；api 路由仅 owner | identity：`signup-modes.test.ts`；api：`admin-invitations.test.ts` | 本地已验证 |
| Passkey：注册 / 登录 / 删除、UV 必需、RP 固定为 issuer、OIDC 流程中继续授权、满足控制台 MFA | identity：`passkey.test.ts`（软件认证器 `test/webauthn.ts`）；e2e：`08-sign-in-methods` | 本地已验证（软件认证器）；真实设备 / 浏览器 WebAuthn **未验证** |
| Magic link：一次性、哈希存储、回调限制、继续授权、TOTP 账号不发链接、限流 | identity：`magic-link.test.ts`；e2e：`08-sign-in-methods` | 本地已验证（outbox）；真实投递**远程未验证** |
| 登录页与邮件中英双语、品牌值校验 | identity：`i18n-brand.test.ts`；console：`brand.test.ts`；e2e：`08-sign-in-methods` | 本地已验证 |
| Passkey 注册的第二因素前置条件（已有 TOTP / Passkey 时需本会话 5 分钟内通过第二因素）、添加通知邮件 | identity：`passkey.test.ts` | 本地已验证（邮件为本地 outbox） |

## v3.1：封禁、代登录、用户导出、产品 Webhook（PRD §21.5–21.6）

| 项目 | 证据 | 状态 |
|---|---|---|
| 封禁 / 解封：所有登录方式在会话创建处拦截，撤销会话与产品 token，refresh 被拒，api 返回 `user_banned`，到期自动解封；社交登录回跳显示封禁提示 | identity：`user-admin.test.ts`；api：`admin-user-admin.test.ts`；e2e：`08-user-admin-webhooks` | 本地已验证 |
| 代登录：仅 owner、需已开启 TOTP 且 5 分钟内验证、不可代登录团队成员、60 分钟上限、token 带 `act`、控制台与账号安全操作被拒、停止后恢复 owner 会话、全程审计 | identity：`user-admin.test.ts`；e2e：`08-user-admin-webhooks` | 本地已验证 |
| 代登录加固：确认表单限流与 5 次错误取消、只进入用户登录过的产品环境、带 `act` 的 token 不能退出产品 / 删除文件（`impersonation_restricted`）、审计记 `metadata.actor_id`、会话不续期、失效会话即时删除、`act` 到期边界拒签、end-session 结束记录 | identity：`user-admin.test.ts`；api：`me.test.ts`、`storage.test.ts`、`audit.test.ts`；e2e：`08-user-admin-webhooks` | 本地已验证 |
| 用户 CSV 导出：按产品环境、邮箱需显式请求、公式注入防护、审计、跨产品隔离 | api：`admin-user-admin.test.ts`、`admin-isolation.test.ts` | 本地已验证 |
| Webhook：Standard Webhooks 签名（参考向量）、SSRF 校验、重试退避与放弃、投递记录、跨产品隔离、`verifyWebhook()` | webhooks / security / api / consumer 单元测试；e2e：`08-user-admin-webhooks`（本地接收端） | 本地已验证；真实出站请求**远程未验证** |
| Analytics Engine SQL：值只允许纯字面量（breakdown 筛选含引号 / 反斜杠 400；AE 返回的不安全值不进第二条查询） | api：`analytics.test.ts`（假 fetch）、`admin-analytics.test.ts` | 本地已验证；真实 AE SQL **远程未验证** |

## 派生前的远程验证摘要（2026-10-09）

本代码派生自一个私有 POC。该 POC 的同一套 Worker 曾部署到 Cloudflare（Workers Free 套餐）验证过：跨产品 SSO 与越权 401、事件经 Queue 进入 Analytics Engine 并可由 AE SQL 查询、R2 S3 预签名直传（含 CORS 预检）、Turnstile 拦截与 siteverify 拒绝路径、Resend 发信、控制台 Workers Static Assets 与管理员 TOTP。当时发现并修复的问题（PATCH 的 CORS、按队列角色路由、AE 数据集可配置、AE 不支持 `uniq`、认证限流改用 D1 计数）都已包含在本仓库中。之后的去品牌化、自部署脚本与初始化流程没有做过远程验证。

## 未验证事项（明确列出）

- 真实 Google / Apple 登录（含 Apple `form_post` 在真实浏览器 `SameSite=Lax` 下的表现）：只用 mock IdP 验证过（D10）。
- R2 S3 兼容预签名（`R2PresignSigner`）：派生前远程验证过；需要部署方提供 R2 S3 API token。
- Analytics Engine 写入与 AE SQL 查询：派生前远程验证过；本地用 D1 替身；查询需要部署方提供 `CF_ANALYTICS_API_TOKEN`。
- 认证限流：Cloudflare Rate Limiting 绑定实测基本不拦截，已改为 D1 固定窗口计数（迁移 `0014_auth_rate_counters`，键为 HMAC，consumer cron 清理过期窗口），派生前远程验证过 429 + `Retry-After`。采集入口（600 批次 / 分钟）仍用绑定，属软限制；v3.1 起部署脚本按前缀派生 namespace，同一账号的多个部署互不影响。
- Turnstile：可选；真人通过挑战后的放行路径未验证。
- 压测、延迟与成本基准、成本告警：未做。
- 备份与恢复演练：未做。
- 管理员 MFA：TOTP + 备用码，或用户验证的 Passkey 登录（本地已验证，Passkey 用软件认证器），默认可选。丢失 TOTP 且用完备用码时用 `pnpm platform:reset-admin --disable-2fa`（远程未验证）；该命令不删除 Passkey。
- 邮件：Resend / SMTP / Cloudflare Email Service 适配器；送达率、退信处理未验证。未配置邮件且要求验证（默认）时邮箱注册、找回密码、Magic link 不可用；运营者可用 `--require-email-verification false` 放开（PRD §21.2 写明风险）。管理员不受影响（由初始化接口直接创建为已验证）。
- 导出一次性链接：已实现（本地已验证）。过期链接（含已使用的）由 consumer 每 15 分钟的 cron 删除（`cron.test.ts` 覆盖）。
- 移动端（RFC 8252 系统浏览器 + 自定义 scheme）流程、scrypt 在 Workers 生产环境的 CPU 时间：未验证。
- 浏览器行为是 Node 中的模拟（Cookie、重定向、CORS 预检），不是真实浏览器引擎；`SameSite` 等 Cookie 属性未模拟。


## 本次集成发现并已修复的问题

1. **consumer 的入口模块导出了非入口对象，导致 Worker 无法启动**。`export const DAILY_CRON` 和 `export { replayDlq }` 在 workerd 中被当作入口点，多 Worker 启动时报错 `Incorrect type for map entry 'DAILY_CRON'`。各模块单独测试时，vitest 插件不会这样解析入口，所以未暴露。修复：入口只导出入口类；常量移入 `cron.ts`；DLQ 重放改为 `ConsumerOps` 服务绑定入口（之前没有任何调用路径）。identity 入口同理不再导出 `getAuth`。
2. **身份域缺少 CORS**：浏览器中的 Web SDK 和控制台需要跨域请求 discovery、JWKS 和 token 端点，但 identity 不返回任何 CORS 头，真实浏览器里的 SPA 登录会失败。e2e 的浏览器模拟按 CORS 规则校验后暴露了这一点（去掉修复后 SSO 用例失败）。修复：discovery / JWKS 允许任意来源；token / revoke / userinfo 只允许已注册重定向 URI 的来源，且不带凭据。
3. **Server SDK 的 `auth.getUser()` 永远无法成功**：`GET /v1/me` 只接受 publishable key，而 Server SDK 只持有 service key。已删除该方法，后端改用 `verifyToken` 返回的 claims。
4. **清理任务与 complete 的竞争**（代码审查发现）：清理未完成上传时若先删 R2 再删行，并发的 complete 可能把记录改成 available，但文件已不存在。修复：cron 先把行改为 deleted（以 `status='pending'` 为条件），再删除 R2 对象和行；complete 的条件更新没有命中时返回 `not_found`。
5. **本地 gateway 防误部署**：配置 `workers_dev: false`，并且只响应 loopback 主机名。

## 复现

```sh
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm test:e2e                      # E2E_KEEP_STATE=1 保留临时状态与 wrangler.log
pnpm bootstrap:local --persist-to .wrangler-state   # 打印本地管理员的随机密码
pnpm platform:deploy --dry-run                       # 只在本地生成部署配置并构建
```


## Phase 3 代码审查（2026-10-09）

- 审查方式：`/code-review high`，覆盖 identity、security、api 中间件、路由、存储、幂等和 consumer。审查方与开发方是同一个模型系列，**不是独立安全审计**；PRD 要求的独立安全审计仍是 MVP 上线门槛。
- 审查共提出 10 条发现，均由 Advisor 对照代码逐条核实，全部属实，均已修复：

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| 1 | cron 选出一批删除申请后，用户撤回其中一条，这一条仍会被执行，导致身份被不可逆地墓碑化 | 改为 `processing` 时检查影响行数，未命中就跳过 | `never runs a request cancelled after the batch was selected`；去掉修复后该测试失败 |
| 2 | 管理员可以先把 revoked 改成 suspended，再改成 active，绕过“撤销不可恢复”的限制 | revoked 对管理员是终态 | `admin-users.test.ts` 增加了这条绕行路径的断言 |
| 3 | `/link/email` 冲突时返回 409，可借此判断邮箱是否已注册，而且没有限流 | 纳入认证限流（残留风险见下） | `limits anonymous-upgrade attempts…` |
| 4 | 匿名用户靠 refresh token 持续使用产品，却被判为不活跃并回收 | 判断活跃时同时看 `product_memberships.last_seen_at` | `does not reclaim an anonymous user who keeps using a product…` |
| 5 | 删除账号时先删数据、最后才撤销 token，中间这段时间用户还能写入新数据 | 改为先撤销 token、再删 membership，然后才删数据 | `cuts off access before deleting data…` |
| 6 | 删除账号后，历史导出文件（含邮箱、姓名）仍保留在归档里 | 一并删除 `exports/{user}/` | `deletes the user's earlier data exports with the account` |
| 7 | 用户主动退出产品后永远无法重新加入 | 清理完成后删除这条 revoked 记录（管理员撤销的不受影响） | product scope 用例按新语义断言；PRD §19.8 已同步 |
| 8 | 幂等键在特定并发时序下，会在没有占位的情况下执行 handler | 只有拿到占位才执行，否则重试一次，再不成功就返回 409 并标记可重试 | 已补充 `idempotency-race.test.ts`，并做过反向验证 |
| 9 | token、revoke、userinfo 的 CORS 判断每次都全表扫描 OAuth client | 在 isolate 内缓存 60 秒 | 回归测试通过 |
| 10 | consumer 手工解析 `product_env_id` | 改用 contracts 的 `parseClientId` | 回归测试通过 |

- 残留风险：匿名升级到 Email 时，必须明确告诉用户发生了冲突（PRD §19.7），所以 409 在设计上就会暴露“该邮箱已注册”，限流只能降低探测速度。MVP 可以考虑先发验证邮件，冲突信息只在邮件里告知。

## v3.1 数据采集、分析与归档（PRD §21.7–21.9，2026-11-04，本地）

| 能力 | 覆盖用例 | 状态 |
|---|---|---|
| Web SDK 错误 / Web Vitals / 点击采集、同意开关、用户属性 | `packages/sdk-web/test/capture.test.ts`（浏览器 API 为测试替身：PerformanceObserver、元素对象） | 本地已验证（真实浏览器未测） |
| 服务端派生上下文、打包队列消息、服务密钥 `user_id` 归属、用户属性接口 | `services/api/test/events-collection.test.ts`；`request.cf.country` 在本地为空 | 本地已验证 / 国家维度远程待验证 |
| consumer 写 `event_rows` / `actor_daily` / `actors`、gzip 归档、重投递幂等、保留期清理、归档到期删除、删除用户的分析数据与导出抑制 | `services/consumer/test/analytics-store.test.ts` | 本地已验证（D1 / R2 为 Miniflare） |
| 漏斗、留存、分组、事件明细、设置、导出及每个路由的跨产品越权 | `services/api/test/admin-analytics.test.ts` | 本地已验证；生产环境的分组走 AE SQL，只用假 fetch 测过 SQL 拼接 → 远程待验证 |
| 端到端：Web / Server SDK → 队列 → consumer → 漏斗 / 留存 / 分组 / 明细 / 导出，隔离与退出产品后的擦除 | `tests/e2e/test/08-analytics.e2e.test.ts` | 本地已验证 |
| 容量（D1 行写入、Queues 操作、AE 250 点 / 调用、R2 Class A）与 Workers Free 10 ms CPU 下的导出 | PRD §21.8 估算，未压测 | 远程待验证 |

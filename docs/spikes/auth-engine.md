# Phase 0 认证引擎门槛验证（PRD §19.1）

- 日期：2026-10-08；基线提交 `8a00ea4`，改动未提交（由负责人审阅后提交）。
- 范围：只在本地运行。所有测试都在 workerd 中执行（`@cloudflare/vitest-plugin` 1.3.7 + Miniflare 本地 D1）。没有执行任何部署或远程命令，也没有使用真实的 Google / Apple 凭据。
- 验证命令：`pnpm --filter @z-cloudbase/identity test`（共 7 个测试文件、31 个用例，全部通过）。

## 1. 版本与选型

| 组件 | 版本 | 说明 |
|---|---|---|
| better-auth | 1.7.7 | 启用核心功能，以及 `anonymous`、`jwt` 两个插件 |
| @better-auth/oauth-provider | 1.7.7 | 提供 OAuth 2.1 / OIDC Provider。peer 依赖 better-call 1.4.0、@better-auth/core 1.7.7、@better-auth/utils 0.4.2、@better-fetch/fetch 1.3.2 需要显式安装 |
| Better Auth CLI | `auth@1.7.7`（npm 包名为 `auth`，不是 `@better-auth/cli`，后者停在 1.4.x） | 用于生成迁移 SQL |
| workerd / wrangler | 1.20261006.1 / 4.148 | 启用 `nodejs_compat`，compatibility_date 为 2026-10-01 |

**D1 接入方式：使用原生支持。** 配置中直接写 `database: env.DB`。`@better-auth/kysely-adapter` 会按 `batch/exec/prepare` 识别 D1 binding，并改用内置的 `D1SqliteDialect`，因此不需要再引入 Kysely D1 dialect 或 Drizzle。限制是 D1 不支持交互式事务，适配器会把 `transaction` 设为 `false`（见 §5 风险 R4）。

**迁移文件 `database/migrations/0002_auth.sql` 由 CLI 生成。** 生成命令为 `npx auth@1.7.7 generate --config <临时配置> --output ...`。临时配置导入 `services/identity/src/auth.ts` 的 `createAuth`，并接一个 `node:sqlite` 内存库。生成后只在文件头部加了注释，表定义没有手改。测试 `0002_auth.sql matches the engine schema on D1` 会在 workerd 中用引擎自带的 `getMigrations()` 对比 D1 上的实际 schema，要求没有待建表、待加列或待加索引。我手工加一个字段做了反向验证，该测试能检测出差异。

`0002_auth.sql` 使用引擎默认的表名和列名：`user`、`session`、`account`、`verification`、`jwks` 和 `oauth*`，列名为 camelCase，与平台表不冲突。PRD 要求认证表使用表前缀，可以通过各模型的 `modelName` 实现，但本次没有做（见 §6 待决项）。

## 2. 门槛结果

| # | 门槛 | 结论 | 证明用例（`services/identity/test/`） |
|---|---|---|---|
| 1 | 在 Workers + D1 上完成注册、登录和会话持久化 | **通过** | `gate1-d1-session.test.ts`：`registers, logs in and persists sessions in D1 with usr_<uuidv7> ids`、`issues an HttpOnly, Secure, SameSite=Lax session cookie valid for 7 days`、`0002_auth.sql matches the engine schema on D1` |
| 2 | 为指定 client 签发 aud 绑定的 token，通过 JWKS 验签，A 产品的 token 被 B 产品拒绝 | **有条件通过：需要修改契约** | `gate2-audience-token.test.ts`：全部 6 个用例。其中 `is rejected by the current @z-cloudbase/security verifyAccessToken` 证明现有契约下验证不通过 |
| 3 | Authorization Code + PKCE 全流程，包括 state 和 nonce | **通过**（有一处不符合 RFC，见下文） | `gate3-authcode-pkce.test.ts`：`authorize -> login -> code -> token, with state echoed and id_token nonce bound`、`rejects a wrong code_verifier and burns the code`、`rejects a reused authorization code`、`rejects an unregistered redirect_uri…`、`serves OIDC discovery` |
| 4 | 匿名用户绑定 Email / Google 后 user_id 不变，凭据已属于他人时冲突、不合并 | **通过（依赖一个小范围补充）**；Google 为本地已验证、远程待验证 | `gate4-anonymous-link.test.ts`：全部 7 个用例 |
| 5 | refresh token 轮换，重放时撤销整个 family | **通过**（撤销范围大于 family；审计事件未实现） | `gate5-refresh-rotation.test.ts`：全部 3 个用例 |
| 6 | 使用引擎内置密码哈希，并在 CPU 限制内完成 | **通过（数据只作参考）** | `gate1-d1-session.test.ts`：`stores an engine (scrypt) hash…`、`hashes and verifies … (indicative)` |

### 门槛 1

- 用户 ID 通过 `advanced.database.generateId` 生成，格式为 `usr_<uuidv7>`，复用 contracts 的 `newUserId`。会话 ID 为 `ses_<uuidv7>`，账号 ID 为 `acc_<uuidv7>`，其余表使用 uuidv7。
- 用 `user.additionalFields` 增加 `lastActiveAt` 和 `deletedAt`，二者都设置 `input: false`。`isAnonymous` 来自 anonymous 插件。`lastActiveAt` 在 `databaseHooks.session.create.after` 中更新。
- Cookie 名为 `__Secure-better-auth.session_token`，属性为 `HttpOnly; Secure; SameSite=Lax; Max-Age=604800`，即 7 天，已由测试断言。

### 门槛 2：需要修改契约（关键发现）

Better Auth oauth-provider 只在请求带 RFC 8707 的 `resource` 参数时签发 JWT access token，并把该 resource 写入 `aud`。如果请求的 scope 包含 `openid`，它还会自动追加 `{issuer}/api/auth/oauth2/userinfo` 作为第二个 audience。此外，`resource` 必须是绝对 URI（`URL.canParse`），因为 `/authorize` 和 `/token` 的 zod schema 都强制这一点；`aud` 也属于保留 claim，不能通过 `customAccessTokenClaims` 覆盖。

因此，引擎**无法**签发 `aud = "product_a.prod"`（裸字符串）的 token。现有 `verifyAccessToken` 有两处会拒绝它：一是 Zod 规则 `aud: z.string()` 不接受数组，二是代码要求 `clientId(pid, env) === aud`。用例 `is rejected by the current … verifyAccessToken` 已经证明这一点。

本次 spike 实际得到的 token：

- header 为 `alg=EdDSA`、`typ=at+jwt`，`kid` 已发布在 `GET /api/auth/jwks.json` 中，JWKS 只包含公钥；
- claims 包含 `iss`、`sub=usr_…`、`aud=["urn:platform:product_a.prod", "<issuer>/api/auth/oauth2/userinfo"]`、`exp - iat = 900`、`jti`、`sid`、`scope`，以及通过 `customAccessTokenClaims` 从 client metadata 得到的 `pid`、`env` 和来自 `user.isAnonymous` 的 `anon`。token 中没有邮箱。
- 每个 client 与自己的 resource 关联（`oauthClientResource`，`enforcePerClientResources` 默认开启）。`product_a.prod` 请求 `urn:platform:product_b.prod` 时，会在 `/authorize` 阶段收到 `invalid_target`。
- 测试中的 `proposedVerify` 是按下文建议契约实现的验证函数。它对 `urn:platform:product_a.prod` 验证通过，对 `urn:platform:product_b.prod` 验证失败。

被否决的替代方案：

- JWT 插件的 `jwt.sign` 可以自定义签名并改写 aud，但前提是 `jwks.remoteUrl`，也就是自己管理密钥和 JWKS，改动不算小。
- 改用 `customAccessTokenClaims` 或 extension claims 写 aud 不可行，引擎会去掉保留 claim。
- 使用不含 `openid` 的 scope 可以让 aud 变成单值，但这样就拿不到 id_token 和 nonce。

**变更请求**见 §7 的 CR-1。客户端，也就是 SDK，**必须**在 `/authorize` 时带上 `resource=urn:platform:{product}.{env}`。不带时引擎会签发 opaque token，API 侧会拒绝，结果是安全失败。用例 `falls back to an opaque access token…` 记录了这一行为。

### 门槛 3

- 完整流程通过 HTTP 跑通：`/api/auth/oauth2/authorize` 在没有会话时 302 到 `/login?<签名后的 oauth_query>`；随后 `POST /api/auth/sign-in/email` 时附带 `oauth_query`，引擎会继续处理 authorize 并返回带 `code`、`state` 和 `iss`（RFC 9207）的回调 URL；最后 `/oauth2/token` 用 PKCE 换取 token。
- `state` 被原样带回，测试中由 RP 侧比对。id_token 使用 EdDSA 签名，`aud = client_id`，`nonce` 与请求一致，并通过 JWKS 验签。
- 产品 client 是第一方 client，注册时设为 `skip_consent: true`。consent 页面（`consentPage: /consent`）已经配置，但本次没有走 consent 分支。
- 错误的 `code_verifier` 会被拒绝，同时 code 被消费，之后再用正确的 verifier 也会失败。**不符合 RFC 之处**：引擎在这种情况下返回 `401 invalid_request`（"code verification failed"），而 RFC 6749 §5.2 要求 `400 invalid_grant`。它的安全效果不变，但严格遵循 RFC 的客户端可能会误判错误类型。（1.7.10 起已改为 `400 invalid_grant`，见 better-auth#11724；本仓库 2026-11-04 升到 1.7.14 后测试按 RFC 断言。）
- 重复使用 code 返回 `400 invalid_grant`。引擎还会撤销该 code 已经签发的 token。
- 未注册的 `redirect_uri` 不会被跳转。

### 门槛 4：引擎自带的匿名“绑定”不符合 PRD，已在引擎外补齐

- **问题**：anonymous 插件的升级方式是匿名会话执行 sign-up 或 sign-in 时**新建一个用户**，在 `onLinkAccount` 回调后删除匿名用户。这样 user_id 会改变，不满足 §19.7。因此没有使用 `onLinkAccount` 做数据迁移，并设置 `disableDeleteAnonymousUser: true`。匿名用户登录已有账号后，匿名账号会原样保留到回收期，见用例 `an anonymous user signing in to an existing account is kept unchanged`。
- **Google（mock）**：匿名会话调用引擎的 `POST /api/auth/link-social`，账号会直接挂到当前 user_id 下。`databaseHooks.account.create.after` 发现用户是匿名用户后，把 `isAnonymous` 改为 false。之后签发的产品 token 中 `anon=false`，`sub` 不变。为此必须开启 `accountLinking.allowDifferentEmails: true`，因为匿名用户的占位邮箱不可能与 provider 邮箱一致。
- **Email/Password**：引擎没有“给匿名用户设置邮箱和密码”的端点，所以新增了 `POST /link/email`（`src/link.ts`，约 30 行）。它完全由引擎原语组成：先用 `internalAdapter.findUserByEmail` 检查冲突，再用 `internalAdapter.updateUser` 写入邮箱，最后调用 `auth.api.setPassword` 由引擎完成哈希并创建 credential 账号。随后同一个 hook 会把 `isAnonymous` 改为 false。这里没有任何协议逻辑，也没有自己实现哈希。
- **冲突**：如果邮箱已被他人使用，返回 `409 identity_conflict`，匿名账号和他人账号都保持不变。如果 Google 身份已被他人绑定，引擎会重定向到 `errorCallbackURL?error=account_already_linked_to_different_user`，不会合并。
- **禁止按邮箱隐式合并**：设置 `accountLinking.disableImplicitLinking: true`。用与已有用户邮箱相同（且已验证）的 Google 账号登录时，会得到 `error=account_not_linked`，已有用户也不会新增 google 账号。
- **如何把 Google / Apple 指向本地 mock**：Better Auth 1.7.7 的 `google` 和 `apple` provider 把端点**写死**在代码里，例如 `oauth2.googleapis.com/token`、`www.googleapis.com/oauth2/v3/certs`、`appleid.apple.com/auth/{authorize,token,keys}`，配置项中没有 endpoint override。本次采用**在测试中拦截 fetch** 的方案：`vi.spyOn(globalThis, 'fetch')` 结合 `@z-cloudbase/testing` 的 `interceptFetch`，把 Google 的 token 和 JWKS 请求路由到本地 `createMockOidcProvider`。浏览器侧的 authorize 由 `mock.authorize()` 模拟。生产配置与测试配置走同一条代码路径，即 `GOOGLE_CLIENT_ID/SECRET` 存在时启用真实的 `google` provider，测试中只注入假值。之所以可行，是因为 vitest-plugin 中测试与 worker 运行在同一个 isolate。另一个方案是 `genericOAuth` 插件配合可配置的 discovery URL，但它会让生产环境的 Google/Apple 改走通用 provider，并失去 Apple 的 form_post 和 client secret JWT 等特殊处理，因此不采用。
- **Apple 未验证**：只做了源码分析。Apple 使用 `response_mode=form_post`，回调是跨站 POST，在 `SameSite=Lax` 下需要确认 state cookie 能否送达；`getUserInfo` 只解码 id_token，不验签，也不校验 nonce（见 R6）。fetch 拦截方式同样适用于 Apple 的 token 端点，但 form_post 回调这一段需要单独测试。

### 门槛 5

- `refreshTokenReuseInterval: 0`：每次 refresh 都返回新的 refresh token，旧 token 会被标记为 revoked。轮换使用条件更新 `UPDATE … WHERE revoked IS NULL … RETURNING`，所以没有事务时也能保证原子性。
- 重放已轮换的 token 会返回 `400 invalid_grant`，引擎同时调用 `invalidateRefreshFamily(clientId, userId)`，测试中当前仍有效的 token 也随之失效。
- **撤销范围大于 family**：引擎会删除该用户在**该 client 下所有设备**的 refresh token，但不影响其他 client（见用例 `revocation scope…`）。这是更保守的做法，代价是用户在同一产品的其他设备上也要重新登录。
- 不会撤销：身份域的会话 cookie，以及已经签发的 JWT access token（最长 15 分钟后自然过期）。
- **安全审计事件没有实现。** PRD §19.4 要求写审计事件，可以在引擎外用一个小范围 hook 补上：在 `hooks.before` 中匹配 `ctx.path === '/oauth2/token' && body.grant_type === 'refresh_token'`；用 `getOAuthProviderApi(ctx, ctx.context.getPlugin('oauth-provider').options).hashToken(token, 'refresh_token')` 计算存储哈希，查询 `oauthRefreshToken`；如果记录存在且 `revoked` 不为空，就写入 `audit_log`（必要时再删除对应 `sessionId` 的身份会话），然后交给引擎继续处理。预计约 20 行，依赖的都是公开导出的 API。

### 门槛 6

- 引擎使用 `@better-auth/utils/password`。在 `workerd` 导出条件下，它会选择 `node:crypto` 的 scrypt（原生实现），参数为 N=16384、r=16、p=1、dkLen=64，内存约 32 MiB。存储格式是 `salt(hex):key(hex)`。
- 本地 workerd 实测（中位数，n=5）：hash 28 ms，verify 28 ms；注册约 56–73 ms，登录约 32 ms（墙钟时间，包含 D1）。**这些数据只作参考**：本地计时不等于生产 CPU 时间，而且 Workers 生产环境的计时器有粒度限制。
- 判断：付费计划默认 30 s CPU，余量很大；免费计划每个请求只有 10 ms CPU，**大概率不够**。需要在远程 staging 上用 `cpuTime` 观测确认。

## 3. 其他确认项

- **会话与 Cookie**：`session.expiresIn = 7d`；`advanced.useSecureCookies: true`；`defaultCookieAttributes = { httpOnly, secure, sameSite: 'lax' }`，已由测试断言。设置了 `session.freshAge = 300`，但在 1.7.7 中它**只限制** `/list-sessions` 和 `/unlink-account`。`/link-social` 和改密码不检查会话新鲜度，PRD 要求的“5 分钟内再认证”仍需要用 before-hook 补上（未实现）。
- **限流钩子**：
  1. 核心配置 `rateLimit` 支持 `customRules`（按路径）和 `customStorage.consume(key, rule)`（原子接口，可以接 Durable Object 或 D1）；
  2. oauth-provider 自带针对 `/oauth2/token|authorize|…` 的规则，这些规则也走核心限流器；
  3. 可以在 Hono 中、引擎之前接入 Cloudflare Rate Limiting binding（`AUTH_IP_LIMITER` / `AUTH_ACCOUNT_LIMITER` 已在 wrangler.jsonc 中声明）。

  本次 spike 设置了 `rateLimit.enabled: false`，因为引擎默认使用内存存储，在多 isolate 环境下没有意义。建议采用第 3 种方式，并辅以 customStorage。这部分**未实现**。
- **以编程方式注册多个 OIDC client**：可行。用例 `registers {product}.{env} clients and platform_console…` 注册了 `product_a.dev`、`product_a.prod`（confidential，secret 只返回一次并哈希存储）和 `platform_console`。实现方式：
  - 使用引擎的 server-only 端点 `auth.api.adminCreateOAuthClient`，并调用 `adminCreateOAuthResource`、`adminLinkClientResource` 关联 resource；
  - client_id 通过 `generateClientId` 和 `AsyncLocalStorage` 固定为 `{product}.{env}`，引擎的管理端点本身不接受指定 client_id；
  - `clientReference: () => 'platform'`，避免 client 归属于注册它的管理员。否则 `oauthClient.userId` 的 `ON DELETE CASCADE` 会在删除该管理员时连带删除产品 client。

  **限制**：这些管理端点**需要身份域会话**，没有会话会抛 UNAUTHORIZED。它们不会通过 HTTP 暴露，HTTP 请求返回 404，已由测试证明。admin API 需要通过 identity Worker 内部的 service binding 路由，带上控制台管理员的身份会话来调用；`clientPrivileges` RBAC 还没有接入。另外，**`web` 类型 client 只接受 https 且非 loopback 的回调地址**，本地开发用的 `http://127.0.0.1` 回调只能注册为 `application_type: 'native'`。
- **Bundle 大小**（参考值）：用 esbuild 本地打包 `src/index.ts` 并 minify 后为 1.41 MB，gzip 后约 346 KB，低于 3 MB 和 10 MB 的限制。没有执行 `wrangler deploy --dry-run`，因为约束禁止运行该命令。
- **静态加密**：开启了 `account.encryptOAuthTokens: true`，第三方 access 和 refresh token 加密后入库。签名私钥由引擎用 secret 加密存入 `jwks` 表。

## 4. 绕过方案与限制汇总

| 绕过方案 | 位置 | 限制 / 移除条件 |
|---|---|---|
| product audience 使用 URN `urn:platform:{product}.{env}`，并以数组形式附带 userinfo aud | `src/auth.ts` `productResource` | 需要 CR-1。如果将来引擎支持关闭 userinfo audience，或支持非 URI 的 audience，可以重新评估 |
| 通过 `generateClientId` 和 AsyncLocalStorage 固定 client_id | `src/auth.ts`、`src/clients.ts` | 依赖“注册时同步调用 `generateClientId()`”这一实现细节，需要在升级时用 `clients.test.ts` 回归。引擎支持指定 client_id 后即可移除 |
| 匿名用户升级为 Email/Password 的端点 `/link/email` | `src/link.ts` | 写邮箱和建 credential 账号是两次写入，不是原子操作，见 R4。没有发送邮箱验证邮件（`emailVerified=false`） |
| `account.create.after` hook 修改 `isAnonymous` | `src/auth.ts` | 只对带端点上下文的写入生效 |
| `allowDifferentEmails: true`（全局） | `src/auth.ts` | 任何已登录用户都能显式绑定邮箱不同的 provider 身份。按 PRD 这是预期行为，但必须配上 5 分钟再认证的 hook，目前未实现 |
| SDK 必须携带 `resource` 参数 | SDK（未实现） | 漏传时会得到 opaque token，结果是安全失败 |

## 5. 风险

- **R1（中）**：插件 API 变化快。1.7.x 的 oauth-provider 与早期的 `oidcProvider` 插件不同，CLI 的包名也改成了 `auth`。建议锁定精确版本，升级时用本组测试回归。
- **R2（中）**：契约修改（CR-1）会影响 `@z-cloudbase/security`、`@z-cloudbase/testing` 的 `createTestTokenMinter`、SDK 和 api 的测试。
- **R3（中）**：refresh 重放时，撤销范围是“同一用户在同一 client 的全部设备”；身份会话不会被撤销，也没有审计事件。
- **R4（中）**：D1 没有事务，多步写入不是原子的，例如注册时的 user + account、client + resource + 关联、`/link/email` 的两次写入。refresh 轮换本身是原子的；如果轮换后的 create 失败，用户需要重新登录，这是安全的失败方向。
- **R5（低）**：错误的 PKCE verifier 返回 401 `invalid_request`，不符合 RFC 6749 的 400 `invalid_grant`。（已在 Better Auth 1.7.10 修复。）
- **R6（中）**：在 Google 和 Apple 的 code flow 中，id_token 来自 back channel，只解码、不验签，也不校验 nonce。这符合 OIDC 对 back channel 的允许范围，但 PRD §4.2 第 9 项要求“验证身份令牌和 nonce”，对 Apple 的要求更高，需要评审确认，或者在 `getUserInfo`/`verifyIdToken` 中补充校验。Apple form_post 在 SameSite=Lax 下的行为也没有验证。
- **R7（低）**：每个 isolate 首次初始化时，引擎会对 D1 做 schema 内省（`validateSchema` 默认开启），冷启动会多几次 D1 查询。可以考虑在生产环境关闭，并依赖迁移流程保证 schema 一致。
- **R8（低）**：表名沿用引擎默认，没有加前缀。
- **R9**：Google 与 mock 的验证均为**本地已验证、远程待验证**，Apple 未验证。

## 6. 待决项（需要负责人决定）

1. 是否接受 CR-1，即 audience 改为 URN 形式并允许数组。如果不接受，就只能自己管理签名密钥（`jwt.sign` + `remoteUrl`），工作量和风险都明显增加。
2. 认证表是否加前缀，例如 `auth_user`。需要在 `user`、`session`、`account`、`verification` 以及插件 schema 中配置 `modelName`，然后重新生成 0002。
3. refresh 重放时是否额外撤销身份会话，以及是否接受“同一 client 的全部设备”这一撤销范围。

## 7. 对 contracts / security 的变更请求（本次未修改，只提出请求）

- **CR-1（必须）**：`packages/contracts`
  - 增加 `productAudience(productId, env) = 'urn:platform:' + clientId(productId, env)`（client_id 保持 `{product_id}.{env}` 不变）；
  - `AccessTokenClaims.aud` 改为 `z.union([z.string(), z.array(z.string()).nonempty()])`；
  - PRD §19.3、§19.4 中“OIDC client_id 同时作为 access token 的 aud”这一表述需要先修改。

  对应修改 `packages/security/src/jwt.ts` 的 `verifyAccessToken`：
  - `audience` 改为 product resource；
  - jose 的 audience 校验保持不变，它本身支持数组；
  - 把 `clientId(pid, env) !== aud` 改为 `productAudience(pid, env) === opts.audience`；
  - 要求 `aud` 中除 `opts.audience` 以外只能是 `${issuer}/api/auth/oauth2/userinfo`，不能出现其他产品的 audience；
  - 可选：校验 `typ === 'at+jwt'`。

  参考实现见 `gate2-audience-token.test.ts` 中的 `proposedVerify`。`@z-cloudbase/testing` 的 `createTestTokenMinter` 也要同步改用新的 aud 形式。
- **CR-2（建议）**：在 contracts 中把 product resource 和 userinfo audience 的路径（`/api/auth/oauth2/userinfo`）定义为常量，避免 SDK、api、identity 各写一份。

## 8. 建议

**继续使用 Better Auth。** 6 项门槛中有 5 项在本地直接通过，或者只需在引擎外做小范围补充，而且这些补充没有任何 OAuth/OIDC 协议逻辑。门槛 2 的差距来自 PRD 契约的写法：`aud` 用的是裸 client_id，而引擎遵循 RFC 8707 和 RFC 9068。修改契约（CR-1）的成本低于更换引擎，也低于自己管理签名。

继续推进前需要完成以下事项：

1. 合入 CR-1；
2. 补上 refresh 重放审计 hook 和 5 分钟再认证 hook；
3. 在前置的 Rate Limiting binding 中实现限流；
4. 在远程 staging 上验证 scrypt 的 CPU 时间和 Apple form_post。

## Advisor 决定（2026-10-08）

1. **CR-1 已采纳并实现**：`@z-cloudbase/contracts` 新增 `productAudience()` / `userinfoAudience()`，`AccessTokenClaims.aud` 允许字符串或数组；`verifyAccessToken` 要求 `typ=at+jwt`，按 URN 形式的 audience 校验，`aud` 中除 userinfo audience 外不允许其他成员。测试签发器同步调整。gate 2 现在直接用 `verifyAccessToken` 验证引擎签出的真实 token。PRD §19.3 / §19.4 已更新。
2. 认证表沿用引擎默认表名，不加前缀。
3. refresh 重放时撤销同一 client 下的全部 refresh token（接受引擎行为）；身份域会话不撤销；审计事件由 Phase 1 identity 补上。
4. 以下作为 Phase 1 identity 的待办，不阻塞 gate：5 分钟再认证 hook、refresh 重放审计、限流（Hono 层接 Cloudflare Rate Limiting binding）、Apple form_post 与 SameSite 的兼容性、第三方 id_token 验签与 nonce 校验（评估在引擎外补充）、`/link/email` 非原子写入的补偿。

# 产品接入教程（给产品项目的 AI 开发者）

> 版本：SDK 0.2.1 · 更新于 2026-11-04
> 本文是产品接入本平台（z-cloudbase 的一个自部署实例）的唯一说明。文中的 `https://id.example.com` / `https://api.example.com` / `https://console.example.com` 是占位符，换成你们部署的地址（`pnpm platform:deploy` 结束时打印，或问平台管理员）。按「执行清单」的顺序做，每一步都有可验证的结果。遇到与本文不符的行为，先记录请求的 `x-request-id` 和错误码，再向平台方反馈，不要自行绕过。

## 0. 执行清单（AI 按顺序完成）

1. 向人类负责人索要第 2 节「需要人类在控制台准备的东西」里的全部信息；缺任何一项都不要开始写代码。
2. 安装 SDK（第 3 节），确认 `tsc` 能识别 `@z-cloudbase/web` / `@z-cloudbase/server` 的类型。
3. 前端接入登录（第 4.2 节）：普通应用用登录页，游戏用游客模式（第 4.3 节）。
4. 用第 4.4 节的 `getUser()` 验证：能拿到 `user_id`，`product_id` 是本产品。
5. 按需接入：埋点（4.6）、错误上报（4.7）、文件存储（4.5）、后端校验 token（第 5 节）。
6. 跑第 8 节「验收清单」，把结果报告给人类负责人。

## 1. 平台模型（必须理解，否则会写错）

| 概念 | 说明 |
|---|---|
| 平台账号 `user_id` | 全局唯一（形如 `usr_01a1…`），同一个人在本平台所有产品里是同一个 `user_id`。**你的业务数据用它做外键。** |
| 产品 `product_id` | 你的产品在平台上的 ID（如 `my_game`），由平台控制台创建。 |
| 环境 `env` | `dev` / `staging` / `prod`，每个产品各有三套，数据、密钥、统计完全隔离。开发阶段用 `dev`。 |
| 可发布密钥 `pk_{env}_…` | 标识「哪个产品的哪个环境」，**不是机密**，可以写在前端代码里。 |
| 服务密钥 `sk_{env}_…` | 后端调用平台 API 的凭证，**机密**，只能放在服务端环境变量里，绝不能出现在浏览器、App 包或仓库中。 |
| 成员关系 membership | 用户第一次登录某产品时自动创建（产品可见性为「公开」时）。「受限」产品只允许已有成员登录。 |
| SSO | 用户在本平台任一产品登录过，再进入你的产品不需要再输密码。 |

硬规则：
- **`product_id` / `env` / `user_id` 只能来自平台签发的凭证和 token**，不要相信前端传给你后端的 `user_id`；后端用 `verifyToken`（第 5 节）从 token 里取。
- 一个产品的 token 不能用于另一个产品（会得到 401），也不要尝试。
- 平台不托管你的业务数据库；平台只提供账号、文件存储、日志、埋点分析。

## 2. 需要人类在控制台准备的东西

控制台：`https://console.example.com`（只有平台团队成员能登录）。请人类负责人完成并提供：

| 项目 | 在控制台哪里 | 给 AI 的值 |
|---|---|---|
| 产品 ID | 产品 → 新建产品（小写字母开头，3–32 位小写字母/数字/下划线，**创建后不可改**） | 例：`my_game` |
| 回调地址 Redirect URI | 产品 → 基本设置 → 重定向 URI（每行一个，对所有环境生效） | 例：`http://localhost:5173/`、`https://game.example.com/` |
| 允许的来源 Allowed origins | 同上 → 允许的来源（页面的 origin，不带路径） | 例：`http://localhost:5173` |
| 可发布密钥 | 产品 → 环境与密钥 → 对应环境那一行 | `pk_dev_…`（开发）、`pk_prod_…`（上线） |
| 存储桶（用文件存储时） | 产品 → 存储桶 → 新建（按环境分别建） | 例：`avatars`、`saves` |
| 服务密钥（有后端时） | 产品 → 环境与密钥 → 创建服务密钥，勾选需要的范围（`logs:write`、`events:write`、`storage:read`、`storage:write`、`users:read`） | `sk_dev_…`，**只显示一次**，直接放进后端的密钥管理 / 环境变量 |
| 可见性 | 产品 → 基本设置 → 可见性 | 游客模式需要「公开」 |

平台地址：

```ts
export const PLATFORM = {
  issuer: 'https://id.example.com',    // 身份域（登录页、OIDC）
  endpoint: 'https://api.example.com', // 平台 API
};
```

> 回调地址必须**逐字符**匹配（包括结尾的 `/`）。本地开发和线上域名都要登记。改完立即生效。

## 3. 安装 SDK

从 npm 安装：

```sh
npm i @z-cloudbase/web       # 前端
npm i @z-cloudbase/server    # 后端（Node 20+ / Cloudflare Workers / 任何有 fetch 的运行时）
```

自托管平台改了 SDK、或不能访问 npm 时，也可以用 tgz 包：平台方在 z-cloudbase 仓库根目录执行 `pnpm sdk:pack`（产物 `dist-sdk/z-cloudbase-web-<版本>.tgz`、`dist-sdk/z-cloudbase-server-<版本>.tgz`），产品仓库把 tgz 放进 `vendor/` 并提交，再 `npm i ./vendor/z-cloudbase-web-<版本>.tgz`。

- 两个包都是 ESM，自带 TypeScript 类型；`@z-cloudbase/web` 只依赖 `jose`，压缩后约 37 KB（gzip 14 KB，含 jose；不用的模块可按 `@z-cloudbase/web/analytics` 等子路径单独引入）。
- 升级：`npm i @z-cloudbase/web@latest @z-cloudbase/server@latest`（用 tgz 时换掉 `vendor/` 里的文件后重新 `npm i`）。
- 不用 JS 的客户端（原生 App、其他语言后端）：直接调 HTTP API（第 6 节）。

## 4. 前端：`@z-cloudbase/web`

### 4.1 初始化（整个页面只创建一次）

```ts
import { createClient } from '@z-cloudbase/web';

export const platform = createClient({
  issuer: 'https://id.example.com',
  endpoint: 'https://api.example.com',
  productId: 'my_game',
  env: 'dev',                                  // 必须与 publishableKey 的环境一致，否则构造时就抛错
  publishableKey: 'pk_dev_xxxxxxxx',
  redirectUri: `${location.origin}/`,          // 必须是控制台登记过的回调地址
  storage: localStorage,                       // 见下方说明
  autocapture: { pageViews: true, sessions: true }, // 可选，见 4.6
});
```

`storage`（refresh token 保存在哪里）：
- 不传：只在内存里，**刷新页面即登出**（但身份域有 SSO 会话，再调一次 `signInWithRedirect()` 会无感登录回来）。
- `sessionStorage`：关掉标签页即失效，适合后台类、安全敏感的应用。
- `localStorage`：长期保持登录，适合游戏；代价是页面若有 XSS，refresh token 可被窃取。access token 始终只在内存。

### 4.2 登录（普通应用）

```ts
// 页面启动时
async function boot() {
  if (new URLSearchParams(location.search).has('code')) {
    await platform.auth.handleRedirectCallback(); // 校验 state / nonce / id_token，换取 token
    history.replaceState(null, '', '/');         // 清掉地址栏里的 code
  }
  const me = await platform.auth.getUser();       // 未登录返回 null；有保存的 refresh token 会自动续期
  render(me);
}

// 用户点「登录」
loginButton.onclick = () => platform.auth.signInWithRedirect(); // 跳到身份域登录页，完成后回到 redirectUri

// 用户点「退出」
logoutButton.onclick = async () => { await platform.auth.signOut(); render(null); };

// 登录状态变化：本页登录成功、从保存的 refresh token 恢复、退出、续期失败时触发（不跨标签页同步）
platform.auth.onAuthStateChange((user) => render(user ? 'signed-in' : null));
```

- 登录页由平台提供（邮箱+密码、注册、找回密码；部署启用时还有 Passkey、邮件登录链接、Google / Apple），你的产品**不要**自己做密码表单，也不要收集密码。所有方式登录后都回到同一个 `redirectUri`，产品代码不需要区分。
- 登录页按浏览器语言显示中文或英文，页面上可以切换；要强制语言，可把用户带到 `https://id.example.com/login?lang=zh`（或 `en`），选择会记住。
- 部署的注册模式（PRD §21.2）决定新用户能否注册：`open` 任何人可注册；`invite` 只有收到平台邀请的人能注册；`closed` 不再创建新账号。后两种模式下，没有账号的用户会停在登录页，产品应提示「请联系平台管理员获取邀请」。
- 回调页可以就是首页，关键是它要处理 `?code=`。

### 4.3 游客模式（游戏等「先玩后注册」的产品）

```ts
// 没有登录态时，直接以游客进入：不出现登录页
if (!(await platform.auth.getUser())) {
  await platform.auth.signInWithRedirect({ guest: true });
}
```

- 用户若已在平台其他产品登录过，会直接以其正式账号进入（不会被降级成游客）。
- 游客也有正式的 `user_id`，`getUser()` 返回 `anonymous: true`。游客数据请同样以 `user_id` 保存。
- **升级为正式账号**：把用户带到 `https://id.example.com/link`（新标签页或跳转），用户设置邮箱+密码后，`user_id` 和所有产品数据**保持不变**。回来后调用一次 `platform.auth.signInWithRedirect()`（SSO，无需输入）刷新 token，`getUser().anonymous` 即为 `false`。
- 游客 30 天不活跃会被平台回收；在游戏里提示用户及时绑定邮箱。
- 产品可见性必须是「公开」，否则游客无法自动加入。
- 只有注册模式为 `open` 的部署允许新游客；`invite` / `closed` 下 `/guest` 返回 403（`details.reason = "signup_closed"`），已有会话的用户不受影响。游戏应在这种情况下改走普通登录（`signInWithRedirect()`）。

### 4.4 当前用户

```ts
const me = await platform.auth.getUser();
// {
//   user_id: 'usr_01a1…',          // 全局 ID：业务数据的外键
//   anonymous: false,
//   product_id: 'my_game', env: 'dev',
//   membership: { status: 'active', joined_at: '2026-10-09T…Z' }
// }
const token = await platform.auth.getAccessToken(); // 调你自己后端时放进 Authorization: Bearer
```

平台**不提供**用户的邮箱、昵称、头像；这些属于产品业务数据，由你的产品自己存（以 `user_id` 为键）。

### 4.5 文件存储（用户私有文件）

```ts
const obj = await platform.storage.createUpload({ bucket: 'saves', file }); // file: File 或 Blob
// obj: { id, bucket, filename, content_type, size, status: 'available', … }
const { url } = await platform.storage.getDownloadUrl(obj.id, { ttlSeconds: 300 }); // 默认 5 分钟，最长 1 小时
const page = await platform.storage.list({ bucket: 'saves', limit: 50 });         // { objects, next_cursor }
await platform.storage.delete(obj.id);
```

- 需要用户已登录；文件只有上传者本人在本产品本环境能看到。
- 字节直传对象存储，不经过你的服务器；下载 URL 是短时效的签名链接，不要存库，用时再取。
- 限制由控制台「环境设置」决定：单文件上限（默认 50 MB）、总配额（默认 5 GB）、每日上传配额（默认 1 GB）、MIME / 扩展名白名单。图片会校验真实文件头。
- 相关错误码：`quota_exceeded`、`payload_too_large`、`unsupported_type`、`not_found`。

### 4.6 埋点分析

```ts
platform.analytics.track('level_complete', { level: 3, score: 1200, stars: 2 });
platform.analytics.identify();  // 用户登录后调用一次：之后的事件关联到该用户（否则按匿名访客统计）
platform.analytics.reset();     // 退出登录时调用
```

- 事件名：小写字母开头，`[a-z0-9_]`，最多 64 字符（如 `purchase_success`）；不合规的事件会被**静默丢弃**。
- 属性：最多 50 个键、序列化后 ≤ 8 KB；值只能是字符串（≤1024）/数字/布尔/null。不要放邮箱、手机号、token 等个人或敏感信息。
- SDK 自动批量发送（默认每 5 秒，页面隐藏 / 关闭时也会发送），自动去重（同一 `event_id` 24 小时内只计一次）。
- 未在控制台登记 schema 的事件：dev/staging 正常接收，prod 按环境设置的「未知事件」策略处理。
- 报表在控制台「数据分析」查看（概览、漏斗、留存、分组、事件明细、导出），约 1–2 分钟延迟。
- 浏览器 / 系统 / 设备类型和国家由平台从请求推断，**不要**自己放进属性（放了也不会被当成这些维度）。

**自动采集**（`createClient({ autocapture: {...} })`，全部默认关闭）：

| 选项 | 事件 | 说明 |
|---|---|---|
| `pageViews: true` | `page_view` | 属性 `path`、`referrer`、`title`；0.2.0 起 `path` / `referrer` 不含查询串（`#/` 开头的 hash 路由保留） |
| `sessions: true` | `session_start` | 30 分钟无事件后换新 `session_id` |
| `errors: true` | `js_error` | 未捕获异常与未处理的 Promise 拒绝：`message`、`type`、`stack`（前 1000 字符）、`source`、`line`、`col`、`path`；屏蔽 token、去掉 URL 查询串；同一错误每页只报一次，每页最多 10 条 |
| `webVitals: true` | `web_vital` | `name`（LCP / INP / CLS / FCP / TTFB）、`value`（毫秒，CLS 无单位）、`rating`；页面隐藏时每个指标报一次。INP 是本页最慢一次交互（近似值） |
| `clicks: true` 或 `'attribute'` | `element_click` | 链接、按钮和带 `data-zcb-track="名字"` 的元素：`tag`、`selector`、`text`（≤ 64 字符）、`href`、`label`。`'attribute'` 只采集带属性的元素；祖先带 `data-zcb-no-track` 的不采集；**从不读取输入框的值** |

**用户同意**：

```ts
platform.analytics.optOut();      // 用户拒绝：清空待发事件和匿名 ID，之后 track / 自动采集都不发送；选择会记住
platform.analytics.optIn();       // 用户同意
platform.analytics.hasOptedOut(); // 当前状态
// 需要「先征得同意再采集」时：createClient({ ..., analytics: { consent: 'denied' } })，用户同意后调 optIn()
```

**用户属性**（只在本产品本环境可见，其他产品看不到）：

```ts
await platform.analytics.setUserProperties({ plan: 'pro', level: 12 }); // 需已登录；值为 null 表示删除该键
platform.analytics.identify({ plan: 'pro' });                            // 登录后关联用户并顺便设置属性（不抛错）
```

- 键 `[A-Za-z0-9_]`，≤ 64 字符；值为标量，字符串 ≤ 256 字符；每个用户最多 20 个键、共 2 KB。超出返回 `payload_too_large`，已有属性不变。
- 游客（匿名访客）没有用户属性，需要时放在事件属性里。
- 用于控制台漏斗 / 留存的「用户属性」筛选，和事件明细里按用户查看。

### 4.7 前端错误上报

```ts
window.addEventListener('error', (e) => platform.logs.captureError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => platform.logs.captureError(e.reason));
```

`captureError` 永不抛错；会去掉 URL 查询参数、截断过长内容、屏蔽 token 类字符串。在控制台「日志」里按环境 / 级别 / 时间检索。

### 4.8 错误处理

所有失败都抛 `PlatformError`：

```ts
import { PlatformError } from '@z-cloudbase/web';
try { … } catch (e) {
  if (e instanceof PlatformError) {
    e.code;       // 见下表
    e.status;     // HTTP 状态码（网络错误时为 undefined）
    e.requestId;  // 反馈问题时附上
    e.retryable;  // true 时可以稍后重试（SDK 已对可重试请求自动重试）
  }
}
```

| code | 含义 / 你该怎么做 |
|---|---|
| `unauthenticated` / `invalid_token` / `token_expired` | 未登录或登录失效 → 调 `signInWithRedirect()` |
| `membership_required` | 受限产品且用户不是成员 → 提示无权限 |
| `product_disabled` | 产品被平台停用 → 显示维护提示 |
| `impersonation_restricted` | 代登录（平台支持人员）期间不允许的操作，如退出产品、删除文件 → 提示“支持会话中不可用” |
| `forbidden` / `forbidden_product` | 无权访问该资源 |
| `validation_failed` / `invalid_request` | 参数不合法，修代码 |
| `not_found` | 资源不存在（或不属于当前用户，平台不区分） |
| `quota_exceeded` / `payload_too_large` / `unsupported_type` | 存储限制，见 4.5 |
| `rate_limited` | 太频繁，按 `Retry-After` 稍后再试 |
| `unavailable` / `internal` / `timeout` / `network_error` | 平台或网络暂时故障，可重试 |
| `state_mismatch` / `nonce_mismatch` | 登录回调被篡改或重复处理 → 重新登录 |

## 5. 后端：`@z-cloudbase/server`

```ts
import { createServerClient } from '@z-cloudbase/server';

export const platform = createServerClient({
  issuer: 'https://id.example.com',
  endpoint: 'https://api.example.com',
  serviceKey: process.env.PLATFORM_SERVICE_KEY!, // sk_dev_…，只在服务端
});
```

### 5.1 校验前端传来的用户（最常用）

```ts
// 前端：fetch('/api/save', { headers: { Authorization: `Bearer ${await platform.auth.getAccessToken()}` } })
const token = req.headers.authorization?.replace(/^Bearer /, '');
const claims = await platform.auth.verifyToken(token!, { productId: 'my_game', env: 'dev' });
claims.sub;   // user_id —— 用它读写你的业务数据
claims.anon;  // 是否游客
```

本地验签（只在首次 / 密钥轮换时拉取一次 JWKS），不调平台 API。别的产品或别的环境的 token 一律校验失败。

**代登录（平台支持人员以用户身份排查问题）**：平台 owner 可以在控制台发起有时限（最长 60 分钟）、全程审计的代登录。此期间签发的 token 带 RFC 8693 `act` 声明：`claims.act = { sub: '<owner 的 user_id>' }`（前端 `onAuthStateChange` / `handleRedirectCallback` 返回的用户对象相应地有 `actor` 字段）。`claims.sub` 仍是被代登录的用户。产品决定如何对待：

```ts
if (claims.act) {
  // 例：禁止支付、提现、删除数据等敏感操作；或全部拒绝
  return res.status(403).json({ error: 'not allowed during a support session' });
}
```

平台自己已保证：代登录会话不能进入控制台，也不能修改该用户的密码、邮箱、登录方式、二次验证，不能导出或删除账号；只能进入用户自己登录过的产品环境（不会替用户加入新产品，也不会触发 `user.joined`）；带 `act` 的 token 调用退出产品（`DELETE /v1/me/membership`）、删除存储对象时返回 403 `impersonation_restricted`，读取、上传和事件上报照常。用户被平台封禁后，已签发的 access token 调用平台 API 返回 403 `user_banned`，refresh 失败（`invalid_grant`），重新登录会被拒绝；你的后端用 `verifyToken` 本地验签时仍会在 token 剩余的最长 15 分钟内通过——需要立即生效时订阅下面的 `user.banned` Webhook。

### 5.4 Webhook（平台推送用户事件）

在控制台「产品 → Webhook」为某个环境添加端点：URL 必须是 `https://`（只有 `dev` 环境允许 `http://localhost`），不能指向内网 / 回环地址；勾选要订阅的事件；保存后签名密钥 `whsec_…` 只显示一次，放进服务端环境变量。

| 事件 | 何时 | `data` |
|---|---|---|
| `user.joined` | 用户第一次在这个产品环境完成登录授权 | `{ user_id, anonymous, first_seen_at }` |
| `user.upgraded` | 游客绑定了第一种登录方式（`user_id` 不变） | `{ user_id, provider }` |
| `user.deleted` | 删除完成：`scope: "account"` 用户删除了平台账号；`"product"` 用户退出了本产品且平台数据已清理 | `{ user_id, scope }` |
| `user.banned` / `user.unbanned` | 平台封禁 / 解封（含到期自动解封，`reason: "expired"`） | `{ user_id, expires_at }` / `{ user_id, reason }` |

请求体统一为 `{ id, type, timestamp, product_id, env, data }`，不含邮箱等个人信息。收到 `user.deleted` 时删除你那边该用户的业务数据。

```ts
import { verifyWebhook } from '@z-cloudbase/server';

// 必须用原始请求体验签，验签通过后再解析
app.post('/webhooks/platform', express.text({ type: '*/*' }), async (req, res) => {
  let event;
  try {
    event = await verifyWebhook({ secret: process.env.PLATFORM_WEBHOOK_SECRET!, headers: req.headers, body: req.body });
  } catch {
    return res.sendStatus(401);
  }
  if (await alreadyProcessed(event.id)) return res.sendStatus(204); // 至少一次投递：按 event.id 去重
  if (event.type === 'user.deleted') await deleteBusinessData(event.data.user_id);
  res.sendStatus(204);
});
```

- 签名遵循 [Standard Webhooks](https://www.standardwebhooks.com/)：`webhook-id`、`webhook-timestamp`、`webhook-signature`（`v1,` + HMAC-SHA256），任何语言都可以按该规范自行验证；时间戳与当前时间相差超过 5 分钟视为重放。
- 只有 2xx 算成功；10 秒超时，不跟随重定向。失败后按 15 分钟、30 分钟、1、2、4、8、12 小时重试，共 8 次（约 28 小时）后放弃。尽快返回 2xx，耗时处理放到队列里。
- 轮换密钥后，旧密钥还会并行签名 24 小时（签名头里有两个签名），在这段时间内更新环境变量即可。
- 控制台可「发送测试」（`webhook.test` 事件）并查看最近 100 次投递记录（状态码、耗时、错误；2xx 记录响应前 256 字符，失败只记状态行）。

### 5.2 服务端日志与事件

```ts
platform.logs.info('order paid', { order_id: 'o_123', amount: 30 }, { request_id: reqId });
platform.logs.error('payment webhook failed', { provider: 'x' });
platform.analytics.track('purchase', { amount: 30 }, { eventId: orderId, userId: claims.sub }); // eventId 用业务 ID（UUID）可防重复计数
await platform.analytics.setUserProperties(claims.sub, { plan: 'pro' });
await platform.flush(); // 请求结束前调用；Cloudflare Workers 里用 ctx.waitUntil(platform.flush())
```

- `userId` 可选：只接受在本产品有有效成员关系的用户（通常就是 `verifyToken` 得到的 `sub`），否则该条事件被拒绝（`membership_required`）。平台只保存它在本产品下的假名，不保存原始 ID。`trackServerEvent` 是 `track` 的旧名，仍可用。
- 服务端事件没有浏览器 / 设备 / 国家维度（服务器的请求不代表用户的设备）。需要前端的匿名 ID 时，把它作为 `anonymousId` 传入。

日志属性中的 `password`、`secret`、`token`、`authorization`、`cookie`、`api_key` 等字段会被自动脱敏；仍然不要主动记录个人信息。

### 5.3 服务端文件

```ts
const obj = await platform.storage.createUpload({ bucket: 'reports', filename: 'r.pdf', contentType: 'application/pdf', body: bytes });
const { url } = await platform.storage.getDownloadUrl(obj.id);
```

需要服务密钥具备 `storage:write` / `storage:read`。

## 6. 不用 SDK：HTTP API

所有请求发往 `https://api.example.com/v1/…`，统一错误体：`{ "error": { "code", "message", "request_id", "retryable", "details?" } }`，响应头 `x-request-id`。

| 头 | 用途 |
|---|---|
| `X-Platform-Key: pk_…` | 前端 / 客户端请求（标识产品与环境） |
| `X-Platform-Key: sk_…` | 服务端请求：始终以「服务」身份处理，即使带了用户 token 也不代表该用户 |
| `Authorization: Bearer <access token>` | 代表某个用户（配合 `pk_`） |

| 方法 路径 | 凭证 | 说明 |
|---|---|---|
| `GET /v1/me` | pk + 用户 token | 当前用户在本产品的信息 |
| `POST /v1/storage/uploads` | pk + 用户 token 或 sk | 申请上传：`{ bucket, filename, content_type, size }` → `{ object_id, method: 'PUT', url, headers, expires_at }`，用这些头把字节 PUT 到 `url` |
| `POST /v1/storage/uploads/{id}/complete` | 同上 | PUT 完成后确认 |
| `POST /v1/storage/downloads` | 同上 | `{ object_id, ttl_seconds? }` → 签名下载地址 |
| `GET /v1/storage/objects?bucket=&cursor=&limit=` | 同上 | 列出文件 |
| `DELETE /v1/storage/objects/{id}` | 同上 | 删除 |
| `POST /v1/events/batch` | pk（可带用户 token）或 sk(`events:write`) | `{ events: [{ event_id(uuid), event_name, occurred_at(ISO), properties?, anonymous_id?, session_id?, user_id? }] }`，≤100 条 / 256 KB；`user_id` 只允许 sk，且必须是本产品成员（否则该条 `membership_required`）；pk 带 `user_id` 的事件被拒（`user_id_not_allowed`） |
| `POST /v1/events/user-properties` | pk + 用户 token，或 sk(`events:write`) | `{ properties: {k: 标量或 null}, user_id? }`（`user_id` 仅限 sk 且必填）→ `{ properties }`（合并后的全部属性） |
| `POST /v1/logs/batch` | pk 或 sk(`logs:write`) | `{ logs: [{ level, timestamp, message, attributes?, request_id? }] }`，≤100 条 / 512 KB |

用户 token 的获取走标准 OIDC 授权码 + PKCE（S256）：授权端点、token 端点见 `https://id.example.com/.well-known/openid-configuration`；`client_id` = `{product_id}.{env}`；必须带 `resource=urn:platform:{product_id}.{env}`；scope `openid offline_access`。access token 15 分钟，refresh token 30 天且每次使用都会轮换（旧的立即失效，重放会吊销整组）。

## 7. 平台限额（默认值）

| 项目 | 限制 |
|---|---|
| 登录 / 注册 | 每 IP 10 次/分钟、每账号 5 次/分钟；部署配置了 Turnstile 时，同一账号或 IP 15 分钟内失败 3 次后需人机验证 |
| 采集 | 每个密钥每分钟 600 个批次 |
| access token / refresh token | 15 分钟 / 30 天（轮换） |
| 上传签名 URL | 10 分钟有效 |
| 事件时间 | `occurred_at` 不早于 7 天前、不晚于 5 分钟后 |
| 用户属性 | 每用户每产品环境 ≤ 20 个键、≤ 2 KB |
| 分析数据保留 | 默认 90 天（部署配置）；原始事件归档默认 90 天，控制台可导出 NDJSON / CSV（单次 ≤ 31 天） |

## 8. 验收清单（接入完成后逐项确认并报告）

- [ ] 首次访问 → 登录（或游客进入）→ 回到产品，`getUser()` 返回本产品的 `product_id` 与 `env`。
- [ ] 刷新页面后仍保持登录（按你选的 `storage` 预期）。
- [ ] 在本平台另一个产品已登录的浏览器里，进入本产品不需要再输密码，`user_id` 相同。
- [ ] 退出登录后 `getUser()` 为 `null`。
- [ ] （有后端）后端用 `verifyToken` 拿到的 `sub` 与前端 `getUser().user_id` 一致；伪造或别的产品的 token 被拒绝。
- [ ] （埋点）控制台「数据分析」在 1–2 分钟内看到你的事件。
- [ ] （错误上报）故意抛一个错误，控制台「日志」能查到。
- [ ] （存储）上传 → 列表 → 下载内容一致 → 删除后下载地址失效。
- [ ] 仓库与前端产物中搜索不到 `sk_`。
- [ ] （Webhook）控制台「发送测试」后，你的接收端用 `verifyWebhook` 验签通过；改动请求体后验签失败。
- [ ] （代登录）决定并实现带 `act` 声明的 token 在你的后端如何处理（至少禁止敏感操作）。

## 9. 当前限制（请告知人类负责人）

- 登录方式取决于部署配置：游客只在注册模式为 `open` 时可用；邮箱+密码注册默认需要部署方配置邮件服务（验证邮件，Resend / SMTP / Cloudflare Email Service）；邮件登录链接只在配置了邮件时出现；Passkey 默认启用；Google / Apple 需部署方配置凭据。真实邮件投递、真实 Passkey 设备与真实 Google / Apple 尚未经过远程验证（本地用替身测试）。
- 服务端渲染应用的「BFF 登录」（`platform.bff(...)`）需要机密客户端，控制台暂不支持创建，暂不可用；请用前端登录 + 后端 `verifyToken`。
- 原生 App（系统浏览器 + 自定义 scheme 回调）尚未验证。
- SDK 默认 15 秒超时并自动重试可重试错误。
- 漏斗 / 留存按「用户」（已登录用 user，未登录用设备匿名 ID）计算，登录前后不会自动合并为同一人。生产环境的「分组」报表基于 Analytics Engine，去重用户数在高流量时是近似值。

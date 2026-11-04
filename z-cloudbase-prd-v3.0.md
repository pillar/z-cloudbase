# z-cloudbase — 可自部署的多产品共享基础后端 PRD v3.0

> 状态：v3.0（2026-11-03）。由私有 POC（PRD v2.2）派生为**开源、可自部署**的通用平台：软件开源（Apache-2.0），每个运营者把它部署到自己的 Cloudflare 账号，部署时设置平台名称，部署脚本为第一个管理员生成随机密码（§20）。v2.2 的功能与技术规格（§1–§19）继续有效，本版的修改以 v3.0 标注。  
> 日期：2026-10-08（v2.2）/ 2026-11-03（v3.0）  
> 命名：项目名 `z-cloudbase`；SDK 包名 `@z-cloudbase/*`，请求头 `X-Platform-Key`，token audience `urn:platform:{product_id}.{env}`。每个部署的显示名称（`PLATFORM_NAME`）与 Cloudflare 资源前缀（默认 `z-cloudbase`）由部署方配置。  
> 定位：基于 Cloudflare 构建的轻量级、多产品共享基础后端平台；借鉴 Supabase 常用能力，但不追求兼容完整 Supabase API。

## 0. 执行摘要

目标是建设一套**每个部署服务一个平台、平台下承载多个独立产品**的基础设施（v3.0：软件开源，任何运营者都可以自行部署一套）。产品既可以是普通 Web App、移动 App、AI 工具，也可以是 Web Game。

- **一个平台身份**：用户只需注册一个平台账号，获得稳定的全局 `user_id`，可进入多个产品；支持跨产品 SSO，同时各产品访问权限独立。
- **共享基础能力**：Auth / SSO、Storage、Logs、用户行为事件采集与基础分析、产品与密钥管理、基础管理后台、SDK。
- **业务完全解耦**：平台不负责产品业务表、业务 API、游戏存档、排行榜、支付、聊天等；产品团队自行决定 D1 / PostgreSQL / 其他数据库及表结构。
- **云端优先**：基础设施优先采用 Cloudflare Workers、D1、R2、Queues、Analytics Engine、Workers Logs；不要求 VPS。
- **刻意克制**：不实现通用 BaaS 数据库编辑器、自动 REST/GraphQL、Realtime 数据库订阅、Edge Functions 市场、通用工作流引擎。

### 0.1 已确认决策与当前阶段

- **部署范围**（v3.0）：每个部署 = 一个 Platform + 多个 Product，由运营者部署在自己的 Cloudflare 账号；类似 WordPress，软件开源、各自部署。项目本身不提供托管 SaaS、多平台租户、计费或第三方自助入驻。
- **认证方式（均属 POC 必测与 P0 范围）**：Email + Password、Google、Apple、匿名登录，以及匿名账号升级/绑定和已有账号安全关联。
- **当前工作阶段（v3.0）**：POC-1 / POC-2 已在本地完成并派生为开源项目；开发与测试在本地进行（Miniflare 模拟 D1 / R2 / Queues，Google / Apple 用本地 Mock OIDC Provider）。部署由运营者在自己的 Cloudflare 账号执行（§20），真实 Provider 凭据由运营者提供。
- **认证技术选择**：先通过 POC 比较 Workers 兼容的成熟 OIDC 方案和可信托管 IdP；不预先承诺完全自建身份引擎。
- **SSO**：统一身份域 + 标准重定向授权，每产品独立 audience 和 membership，不共享跨域会话 Cookie。
- **隐私**：默认产品级隔离；平台不默认将跨产品用户行为明细提供给任一产品。
- **分析保留**：POC 按 90 天可用分析窗口设计，长期原始事件 R2 归档为可选能力；实际产品保留规则可在运营前配置。
- **日志检索**：初期仅产品、环境、时间、级别、request_id 等结构化查询；不做全文搜索。

### 0.2 一句话验收目标

一个新产品在控制台创建后，开发者安装 SDK、填写 `product_id`，即可接入同一套登录身份、私有文件、错误日志和用户行为数据；产品可以自建任何业务表，且不会暴露其他产品的数据。

## 1. 背景与问题

传统按项目组织的 BaaS 容易让每款产品产生独立用户池、独立登录体验、重复的 Auth / Storage / Observability 接入以及分散的用户分析。我们的需求相反：**以平台为账号根，产品为授权与数据隔离边界**。

不把“用户属于某个产品”当作身份模型的根：**用户属于平台，产品拥有该用户在本产品内的成员关系、授权和事件数据。**

### 1.1 核心概念与对象

| 概念 | 定义 | 说明 |
|---|---|---|
| Platform | 运营主体与统一身份域 | 每个部署只有一个 Platform；不建设多平台租户能力。显示名称由部署配置（v3.0） |
| Product | 平台下的一个应用或游戏 | 拥有唯一 `product_id`、域名、环境、权限配置、分析视图 |
| Global User | 平台用户 | 永久唯一的 `user_id`，不因注册新产品而变化 |
| Product Membership | 用户与产品的关联 | `user_id` + `product_id`；记录准入、首次访问、状态和产品特定用户标识（可选） |
| Environment | 产品环境 | `dev`、`staging`、`prod`，凭据与文件/事件必须隔离 |
| Principal | 请求行为主体 | 终端用户、服务账号或系统任务，授权能力不同 |

### 1.2 非目标（明确不做）

- 不提供产品业务数据表的建模、编辑、迁移、通用 CRUD API。
- 不提供 Supabase PostgREST、完整 RLS 兼容、数据库触发器、GraphQL 或 PostgreSQL 托管。
- 不承担产品领域逻辑（游戏排行榜、商城订单、积分系统、协作数据等）。
- 不在 MVP 实现实时 WebSocket 同步、消息总线产品化、AB 测试、营销自动化、复杂 BI。
- 不开发面向第三方公司的多租户 SaaS、租户隔离、订阅计费或第三方开发者自助入驻。
- 不将用户跨产品行为自动开放给所有产品管理员。

## 2. 用户角色与典型场景

| 角色 | 操作 | 权限原则 |
|---|---|---|
| Platform Owner | 管理平台策略、全部产品、密钥、审计 | 最高权限；敏感动作二次验证 |
| Platform Operator | 查看平台健康、协助排障 | 按需授权，默认不读私有文件内容 |
| Product Admin | 配置自己产品的域名、存储规则、日志与事件 | 仅限授权产品与环境 |
| Product Developer | 查看 SDK、开发凭据、调试事件 | 默认无法接触生产私钥 |
| End User | 注册、登录、查看产品接入、管理会话、导出/删除数据 | 操作自己的数据，不管理其他用户 |
| Server Service | 产品自己的后端 | 使用短期服务凭证 / scoped service key，只能访问本产品受允许能力 |

典型流程：用户 A 首次登录产品 X，建立平台账号和 X 的 membership；随后访问产品 Y，使用统一身份进行 SSO；Y 拥有独立 access token / audience、自己的 membership 和存储权限，不得因为 X 的登录状态而直接读取 X 的私有数据。

## 3. 信息架构与系统边界

```text
                       Platform Identity Domain
                     (login.example.com / SSO)
                                 |
                        Auth Service (Workers)
                                 |
                   Global User / Session / Grant
                                 |
        +------------------------+------------------------+
        |                        |                        |
     Product A                Product B                Product C
    Web / Mobile             AI / SaaS                 Web Game
        |                        |                        |
       SDK                      SDK                      SDK
        +------------------------+------------------------+
                                 |
                    Platform API Gateway (Workers)
                   /auth /storage /logs /events /admin
                     |        |         |        |
                     D1       R2     Queues   Analytics Engine
                     |                  |        |
               Platform Meta       Log/Event    Aggregate
               & Auth State        Processors    Queries

        各产品独立业务后端与数据库（平台不管理其表结构）
```

### 3.1 Cloudflare 服务职责

| 组件 | 用途 | 是否 MVP 必需 |
|---|---|---|
| Workers + Hono | API、Auth、租户/产品权限、签发上传许可 | 是 |
| D1 | 用户、凭证元数据、产品、成员关系、会话、授权与审计索引 | 是 |
| R2 | 多产品对象文件、可选原始日志归档、事件长期归档 | 是 |
| Queues + DLQ | 日志/事件异步处理、批量写入、重试与死信 | 是 |
| Workers Logs | 平台自身请求/异常观测 | 是 |
| Analytics Engine | 高频行为事件的汇总与查询 | 是，视实际查询和保存周期辅以 R2 |
| Turnstile / WAF / Rate Limiting | 认证和采集入口的滥用防护 | 是 |
| KV | 非关键配置/缓存 | 可选，不承担强一致认证状态 |
| Durable Objects | 精细化节流、串行协调（如有必要） | 非 MVP，按需要添加 |
| Cron Triggers | 生命周期处理、聚合、保留期清理 | 是 |

> 选型依据：Cloudflare D1 付费计划单数据库容量上限为 10 GB，且单库查询串行处理；Workers Analytics Engine 当前数据保留 3 个月；Workers Logs 的保留期较短。因此**不能**用一个 D1 无限积累全部事件，也不能把 Workers Logs 作为长期审计存储。具体额度和价格在上线前重新核验。

## 4. 目标功能需求 — P0（POC 优先验证）

### 4.1 产品注册与环境管理

- 在管理后台创建、停用、归档产品；生成不可变 `product_id`。
- 配置显示名、回调 URL 白名单、允许来源域名、隐私策略与数据保留策略。回调 URL 白名单至少一项（创建与修改时为空返回 400 `validation_failed`；v3.1 起明确，此前空列表会在 identity 侧失败为 500）。
- 每个产品有 `dev` / `staging` / `prod` 环境；不同环境拥有独立公钥标识、服务凭证、R2 前缀及分析环境标签。
- 支持产品管理员/开发者分配；所有管理动作进入审计日志。
- 客户端发布 `publishable key` 仅用于标识产品/环境，不作为安全凭证；密钥仅在服务器持有，轮换可撤销。

**验收**：产品 A 的开发人员不能修改/查询产品 B 的配置；停用产品后新的认证授予与文件写入立即拒绝，已有会话的失效遵循配置并可强制吊销。

### 4.2 Auth & 跨产品 SSO

**P0 目标登录能力（POC 每项必须覆盖）**：

1. Email + Password（使用成熟且持续维护的密码哈希/认证实现；密码不可明文或可逆存储）。
2. Email 验证、找回密码；需要邮件服务供应商，项目预留 Provider Adapter。
3. 统一网页登录域；基于 **OIDC Authorization Code + PKCE** 的浏览器/移动应用授权流程（实现采用成熟协议库并执行兼容性与安全审计，禁止临时自创 OAuth 协议）。
4. 短期 access token、可轮换 refresh token、注销与会话撤销；token 必须校验签名、issuer、audience、exp、权限。
5. 全局用户资料基础字段；每产品独立 membership / 授权同意记录。
6. 登录限流、验证码/风控挑战、异常登录告警、密码重置后相关会话撤销策略。
7. 公钥通过 JWKS 发布、签名密钥可轮换；服务端机密不下发浏览器。
8. **Google 登录**：OAuth/OIDC 标准授权，验证 provider subject、email_verified 等声明；同一 Google 身份重复登录映射到同一全局用户。
9. **Apple 登录**：支持 Sign in with Apple，验证身份令牌、nonce、audience、签名和有效期；支持 Apple 隐藏邮箱（private relay），不得以邮箱是否一致作为唯一绑定依据。Apple 开发者配置及实际设备/浏览器兼容性列入 POC 前置条件。
10. **匿名登录**：服务端生成具备权限范围的匿名全局用户与会话；匿名用户可进入多个开放产品，但受产品准入策略约束；匿名身份不是可信持久身份，需明确会话丢失后的不可恢复风险。浏览器产品经身份域的游客入口进入：Web SDK `signInWithRedirect({ guest: true })` → `GET {issuer}/guest?authorize=<本 issuer 授权地址>`；无会话时在身份域创建匿名会话（第一方 Cookie）后继续授权，已有会话保持不变；continuation 只接受本 issuer 的授权端点；按 IP 限流（2026-10-09 补充）。
11. **匿名升级 / 身份绑定**：可升级为 Email、Google 或 Apple 账号并尽可能保留原 `user_id` 与已关联产品数据；若目标凭证已属于另一全局账号，禁止自动合并，进入显式冲突处理流程。
12. **防止账号接管**：绑定第三方 Provider 须有当前会话与必要的近期再认证；禁止仅因邮箱相同自动合并账户；Provider 回调校验 state/nonce/PKCE、固定回调 URL 白名单。

**重要语义**：

- 全局账号唯一：统一 `user_id`，一次身份验证支持多个产品 SSO。
- **SSO ≠ 跨产品 API 通行证**：每个产品获取该产品 audience 的受限 token，不能直接使用产品 A 的 token 调用产品 B 私有接口。
- 首次进入产品可自动创建 membership（限开放产品）；受限产品须显式授予准入。
- 产品可另设权限组 / 业务角色，平台只管理基础访问声明，**业务授权由产品后端负责**。
- 不鼓励在登录前强制采集不必要的个人信息。

**P1 候选（不属于本次 POC）**：Passkey/MFA（管理员 MFA 仍属于安全上线门槛）、企业 SAML、组织账户、自定义社交登录供应商。Google、Apple、匿名登录及绑定已确定为 P0，不得推迟到 P1。

**POC 验收**：Email、Google、Apple、匿名各自可得到明确的全局身份；同一用户登录产品 A、B 时全局 ID 不变且 membership 独立；匿名升级保留 ID 与关联；Provider 重复登录不生成重复账号；已存在凭证冲突绝不静默合并；A token 用于 B API 必须拒绝；refresh token 轮换与重放检测通过测试。

### 4.3 Storage — 跨产品统一文件服务

- 提供对象上传授权、下载授权、查询元信息、删除、列表与配额统计。
- 底层使用 R2；逻辑上按 `platform/product/environment/bucket/user-or-scope/object` 隔离；禁止直接把用户文件名当作可信对象路径。
- **私有文件默认值**：通过后端鉴权后发放短有效期预签名 URL；公共文件由明确授权的独立发布路径提供。
- 大文件由客户端直接上传 R2（预签名 PUT / multipart 方案），Worker 不承担文件透传。
- 上传申请先校验产品、用户、类型、大小、配额；上传成功后服务端校验对象存在、大小和实际类型（必要时扫描），然后写入可用元信息。
- 支持删除与生命周期策略；同一平台用户不能天然读取其在其他产品下的私有文件。
- 可按产品设置总容量、单对象上限、文件扩展名/MIME 白名单、单日上传配额。

**验收**：A 产品私有文件无法用 B token 取得下载权限；超配额和非法路径被拒绝；URL 到期后不可继续使用；删除操作可追踪。

### 4.4 Logs — 多产品应用日志

定义两类日志，避免混淆：

1. **Platform Operational Logs**：平台 API 延迟、状态码、异常与组件健康；底层 Workers Logs，加上监控和告警。
2. **Product Application Logs**：产品主动提交的结构化服务端日志，包含级别、时间、product_id、environment、request_id、trace_id、event_name、message 和受约束的 attributes。

- SDK 支持服务端 `logger.info/warn/error`；浏览器允许上报受限的错误报告，**不允许浏览器伪装可信的审计日志**。
- 入口按凭证限流、约束单条大小、禁止上传密钥、令牌、密码和个人敏感信息；必要时脱敏。
- 异步写队列并路由至按日期分区的 R2 日志归档；管理后台仅提供时间窗口/产品/级别/请求 ID 的有限检索（索引方案另行设计）。
  - 检索接口（2026-11-04）：`GET /v1/admin/products/:id/logs?env=&from=&to=&level=&request_id=&limit=&before=`，`logs:read`。时间窗口默认最近 24 小时；结果**按时间倒序（最新在前）**，同一时间按归档位置定序；`limit` 1–200（默认 100）。响应 `{ logs, next_before }`：`next_before` 为不透明游标，原样作为下一次请求的 `before`（其余参数不变）取更早的一页，没有更多时为 `null`；格式错误的游标返回 400 `validation_failed`。单次请求最多读取 50 个归档对象，超出时提前结束本页并返回游标。
- 管理员操作、密钥轮换、会话安全事件进入**不可由普通产品用户修改的独立审计流**。
- 定义保留期、脱敏和删除流程；不能承诺 R2 原始日志具备全文检索，MVP 只实现可控范围的结构化查询。

**验收**：任意日志可用 request_id 在限定时间内定位，平台事故可串起 API 调用和异常；日志写入失败不阻塞主要请求，并能追踪丢失/重试。

### 4.5 Analytics — 用户行为事件采集

**核心需求**：任何产品不需要自行建设事件收集 API，就能通过 SDK 上报统一格式事件，并在后台查看基础指标。

事件格式（示意）：

```json
{
  "event_id": "uuid-v7-or-uuid",
  "product_id": "product_a",
  "environment": "prod",
  "event_name": "page_view",
  "occurred_at": "2026-10-08T10:00:00Z",
  "anonymous_id": "device-scoped-pseudonymous-id",
  "user_id": null,
  "session_id": "session-scoped-id",
  "properties": { "path": "/home" },
  "schema_version": 1
}
```

注意：`product_id` / `environment` / `user_id` 不能仅信任客户端请求体，服务器必须由凭证及验证过的会话派生或校验。匿名事件应有独立产品范围内的匿名标识，不自动跨产品关联。

- Web TypeScript SDK P0：`track(name, properties)`、`identify()`（仅用已认证的身份）、`reset()`、页面浏览和会话基础采集（按配置启用）。
- HTTP ingestion API：可批量提交事件，带 event_id 幂等处理、事件体积上限、命名规则与字段白名单。
- 队列异步消费后写 Analytics Engine 聚合数据；如需长期原始事件，归档到 R2（压缩 + 日期/产品分区），不塞入平台用户 D1。
- 默认报表：日活 DAU、周活 WAU、月活 MAU、事件次数、独立用户/匿名访客、基本留存（P1 若计算成本过高）、按产品/环境查看趋势、TOP 事件。
- 产品可注册事件定义与属性 Schema；未经登记的事件在开发环境显示警告，在生产环境可选择接收/拒绝。
- 支持用户数据查询导出和删除请求；最小化收集、配置化同意管理、保留期和地域合规策略。
- **身份隐私边界**：平台运营者可看全平台汇总数据；产品管理员仅能看自己的产品；跨产品用户画像默认关闭，不因为账号统一就自动共享细粒度行为记录。

**验收**：一个产品发出的事件绝不能在另一产品面板出现；重复的 `event_id` 在定义的去重窗口中只统计一次；失效或无效批次返回明确定义的错误响应。

### 4.6 控制台 Dashboard

- 登录平台管理后台，查看被授权产品列表和环境状态。
- 产品详情包括：基本信息、回调 URL、密钥管理、Auth 用户及成员关系概览、Storage 容量/文件列表、Logs 检索、Analytics 仪表盘。
- 用户管理：按全局用户 ID / 邮箱定位（仅有权限的人员），查看产品 membership、活跃会话、封禁/解除访问、导出/删除申请状态；敏感操作审计。
- 概览用量：请求量、事件量、文件用量、错误率和预估成本（明确估计值而非账单真值）。
- 内部 RBAC；平台管理员与产品管理员必须看到不同的数据边界。

### 4.7 SDK / API

- SDK 首发：`@z-cloudbase/web`（TypeScript 浏览器）；`@z-cloudbase/server`（Node/Workers 服务端）；纯 HTTP API 便于移动端及其他语言接入。
- SDK 由独立服务模块组成：`auth`、`storage`、`logs`、`analytics`；支持按需导入，避免普通 App 被强制捆绑所有模块。
- 对外 API 统一 `/v1`；OpenAPI 3.1 生成契约、示例、SDK 类型和测试。
- 采用标准化错误格式、request_id、明确的 retryable 标记，重要写操作支持 `Idempotency-Key`（格式与错误码见 §19.5）。

示例：

```ts
const client = createClient({
  endpoint: 'https://api.example.com',
  productId: 'product_a',
  publishableKey: 'pk_prod_...'
});
await client.auth.signInWithRedirect();
const me = await client.auth.getUser();
await client.analytics.track('feature_used', { feature: 'editor' });
const upload = await client.storage.createUpload({
  bucket: 'avatars', filename: 'avatar.png', contentType: 'image/png'
});
// 根据 upload 指示将内容直接上传到 R2，完成后 finalize
```

> API 名称为 PRD 草案，最终以 OpenAPI 契约为准；上述调用不意味着 JWT、OAuth 服务端行为可以省略。

## 5. 功能需求 — P1 / P2

| 阶段 | 候选功能 | 触发条件 |
|---|---|---|
| P1 | Passkey、终端用户 MFA 与账户恢复增强 | POC 四类登录全部验证后，再评估附加登录方式 |
| P1 | 自定义认证邮件模板与域名 | 品牌一致性需求 |
| P1 | 客户端崩溃追踪 / Source Maps 关联 | 前端错误定位需求 |
| P1 | 高级漏斗、留存和 cohort 分析 | 事件规模和数据质量稳定后 |
| P1 | Storage 图像变换 / 缩略图 | 用户上传图片的产品增加 |
| P1 | 各产品独立 SSO 外观、品牌化登录页 | 产品品牌差异增大 |
| P2 | 第三方平台/组织租户接入 | 决定对外出售 BaaS 服务后 |
| P2 | 企业 SSO、SAML/SCIM | 企业客户明确提出需求 |
| P2 | 外部数据仓库同步和自定义报表 | 需要复杂 SQL 与长期历史分析 |

## 6. 身份与权限设计（重点）

### 6.1 三种独立身份关联

- **Global Identity**：`user_id` 与认证方式；平台拥有。
- **Product Access**：`user_id + product_id` 的 membership、是否允许进入以及少量访问声明；平台拥有。
- **Product Business Profile**：昵称、会员等级、订单、游戏角色或任意业务字段；产品自己拥有和管理，平台不创建这些表。

### 6.2 身份验证流程

1. 产品前端初始化 SDK，读取公开 `product_id` 和 `publishable key`。
2. 用户点击登录，前端经 Authorization Code + PKCE 重定向到平台身份域。
3. 平台确认全局身份，并按目标产品准入策略创建/读取 membership；如需授权提示则显示。
4. 平台为该产品发放 audience 限定的 access token，配套刷新与吊销策略。
5. 产品后端通过 JWKS 验签并验证 audience、issuer 和权限，使用 `sub` 作为稳定全局用户标识。
6. 用户前往另一产品，可借助身份域现有登录会话再次完成授权，但必须取得该产品独立 token。

### 6.3 安全红线

- 禁止共享无 audience 限制的万能 JWT。
- 令牌不得放入 URL 查询参数；Web 端优先安全的 BFF + HttpOnly/Secure/SameSite Cookie 方案，纯 SPA 需实施 PKCE、严格 CSP 与 XSS 防护策略。
- 所有管理员操作均需服务端 RBAC 判断，不可信任前端隐藏按钮。
- 所有 Storage / Analytics / Logs 写入必须确定产品和环境上下文；`user_id` 来自已验证的身份，不从任意 JSON 中直接取值。
- 用户注销、删除和产品停用必须有令牌失效/密钥撤销机制；短期令牌和服务器会话撤销共同发挥作用。
- 产品密钥轮换支持过渡期、版本化 `kid`、紧急禁用与审计。

## 7. 平台元数据（只定义平台自己的表）

**强调：本节绝不是产品业务数据库模板。** 下列仅是平台自身工作必需的逻辑实体；实际 SQL 可在技术设计阶段优化。

| 表/实体 | 主要字段 | 用途 |
|---|---|---|
| `platforms` | id, name, status | 每个部署唯一的平台；不开放新建平台 |
| `products` | id, platform_id, name, status, visibility | 产品注册 |
| `product_environments` | id, product_id, env, issuer_config | 环境隔离 |
| `users` | id, email_normalized, status, created_at | 全局身份；匿名用户允许邮箱为空；升级时保留全局 user_id |
| `user_credentials` | id, user_id, provider, provider_subject, password_hash_ref | Email / Google / Apple / 匿名身份标记及第三方 subject 映射 |
| `product_memberships` | user_id, product_id, status, joined_at | 产品准入与关联 |
| `oauth_clients` | id, product_id, redirect_uris, type | OAuth/OIDC Client 配置 |
| `auth_sessions` | id, user_id, status, created_at, expires_at | 平台会话与设备 |
| `refresh_token_families` | id, session_id, token_hash, rotation_state | 刷新令牌轮换/重放检测 |
| `service_credentials` | id, product_env_id, scope, secret_hash, revoked_at | 服务到服务访问 |
| `storage_buckets` | id, product_env_id, name, visibility, policy | 逻辑存储容器 |
| `storage_objects` | id, bucket_id, owner_id, object_key, size, status | 对象元信息与授权 |
| `event_schemas` | id, product_env_id, name, schema_version | 事件注册与校验 |
| `team_members` | principal_id, role, scope_id | 控制台 RBAC |
| `audit_log_index` | id, action, actor_id, target_id, occurred_at, archive_ref | 可检索审计索引 |
| `deletion_requests` | id, user_id, scope, status, due_at | 导出/删除流程 |

v2.2 补充字段与表（POC 必需）：

- `users` 增加 `is_anonymous`、`last_active_at`、`deleted_at`（墓碑）；`products` 的 `visibility` 取值为 `open` / `restricted`，`status` 取值为 `active` / `disabled` / `archived`。
- `product_memberships.status`：`active` / `suspended` / `revoked`。
- `product_environments` 增加 `publishable_key`、`user_key_salt`（用于 §19.8 的 HMAC）。
- 新增 `idempotency_keys`（凭证, 路由, key, request_hash, response, expires_at）、`email_outbox`（仅本地 / 测试 Adapter），以及 `ingest_db.event_dedup`（product_env, event_id, expires_at）。
- 认证引擎（Better Auth）自带的表与上表的映射在 Phase 0 确定，以引擎 schema 为准，不重复建同义表。

**D1 规模策略**：平台 Auth 与元数据从独立 D1 开始，必要时分库（认证库/存储索引库/配置库），明确迁移和备份计划；高频原始事件不要直接写认证库。

## 8. API 草案

| 类别 | 端点 | 目的 |
|---|---|---|
| Discovery | `GET /.well-known/openid-configuration`、`GET /jwks.json` | OIDC 发现与公钥 |
| Auth | `GET /authorize`、`POST /token`、`POST /revoke`、`GET /userinfo` | 标准身份授权流程（具体按规范实现） |
| Auth | `POST /v1/auth/register`、`POST /v1/auth/password/reset` | 注册、密码重置（需防枚举） |
| Users | `GET /v1/me`、`GET /v1/me/products` | 用户与可访问产品 |
| Storage | `POST /v1/storage/uploads`、`POST /v1/storage/uploads/:id/complete` | 创建及确认上传 |
| Storage | `POST /v1/storage/downloads`、`GET /v1/storage/objects`、`DELETE /v1/storage/objects/:id` | 私有文件操作 |
| Logs | `POST /v1/logs/batch` | 服务端结构化日志采集 |
| Events | `POST /v1/events/batch` | 用户行为批量事件 |
| Admin | `POST /v1/admin/products`、`GET /v1/admin/products` | 产品生命周期管理 |
| Admin | `GET /v1/admin/products/:id/usage` | 用量概览 |
| Admin | `GET /v1/admin/products/:id/analytics` | 基础统计 |

> Auth 标准端点不得凭表格自行造协议；具体请求、响应和错误码严格以 OIDC/OAuth 规范及已选实现为准。全部其他端点需生成 OpenAPI 合同并测试。

## 9. 日志与行为分析存储管道

```text
Product Server Logs ---+
                       +--> Ingestion Worker --> Queue --> Consumer --> R2 Partitioned Archive
Browser Errors --------+                              |
                                                      +--> Small Search Index / Alert
Product Event SDK -----+--> Event Worker ------> Queue --> Consumer --> Analytics Engine
                                                            |
                                                            +--> optional R2 raw archives

Workers' own Logs ---> Cloudflare Workers Logs / alerting
Security Audit -----> separately protected audit archive + D1 index
```

- 输入端定义吞吐限额、压缩、批量大小、最大时间偏差、用户同意状态和敏感字段过滤。
- 队列采用至少一次交付语义：事件必须支持幂等/去重（明确定义窗口，不承诺无限期全局精确去重）。失败进入 DLQ，可监控回放。
- 事件展示默认以 Analytics Engine 聚合为主；产品级长期事件原文导出依靠 R2，而非无限延长 Analytics Engine 的数据保留。
- 不为原始日志/事件承诺任意全文检索与跨事件复杂 JOIN；复杂查询应导出到专门分析系统，留待后续版本。
- 采集端批量缓冲：页面卸载时 best-effort flush，失败可重试；不得阻塞产品核心功能。可设置采样/节流避免成本失控。

## 10. SDK 功能规范

### Web SDK

- `auth.signInWithRedirect()` / `auth.signOut()` / `auth.getUser()` / `auth.onAuthStateChange()`
- `storage.createUpload()` / `storage.completeUpload()` / `storage.getDownloadUrl()` / `storage.delete()`
- `analytics.track()` / `analytics.identify()` / `analytics.reset()` / `analytics.flush()`
- `logs.captureError()`（浏览器受限）

### Server SDK

- `auth.verifyToken(token, expectedProductId)` / `auth.getUser()`（服务端）
- `storage.createUpload()` / `storage.getDownloadUrl()`（服务凭证受限）
- `logs.info()` / `logs.warn()` / `logs.error()`
- `analytics.trackServerEvent()`

SDK 必须支持 Tree-Shaking、超时/指数退避（仅限可安全重试请求）、避免重复事件、脱敏、环境隔离、兼容 Workers runtime；不依赖 Node 专有 API 才能在 Cloudflare 使用。

## 11. 项目代码结构（Monorepo）

```text
cloudbase/
├── apps/
│   ├── console/                # 平台管理前端
│   ├── identity-ui/            # 统一登录 / 授权 / 用户中心
│   └── docs/                   # API 与 SDK 文档
├── services/
│   ├── api-gateway/            # 认证上下文 / 路由 / 限流
│   ├── auth/                   # OIDC / 用户 / 会话
│   ├── storage/                # R2 授权 / 元数据 / 配额
│   ├── ingest/                 # logs & events 入口
│   ├── worker-consumers/       # Queues 消费
│   └── scheduled/              # 定时清理 / 聚合
├── packages/
│   ├── sdk-web/
│   ├── sdk-server/
│   ├── contracts/              # OpenAPI / Schema / Typed Errors
│   ├── security/               # 鉴权中间件 / RBAC / 签名
│   └── shared/                 # 平台公共工具
├── database/
│   ├── migrations/             # 只管理平台元数据
│   └── seeds/
├── infra/
│   ├── wrangler/
│   └── scripts/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── security/
└── docs/
    ├── prd.md
    ├── architecture.md
    ├── threat-model.md
    └── runbooks/
```

代码结构是建议，**产品 A/B/C 的业务代码和数据库不放在这个 Monorepo**；它们仅依赖平台 SDK 和标准 API。

> v2.2：POC 阶段将 `services/*` 收敛为 3 个 Worker（identity / api / consumer），见 §19.2。上面的目录图是长期形态，不是 POC 的必选拆分。

## 12. 非功能性需求和验收 SLO（初始目标，不是已达成能力）

| 类别 | MVP 目标/约束 | 测量方式 |
|---|---|---|
| API 可用性 | 月度目标 ≥99.9%（排除明确约定的维护窗口） | 外部合成监测 |
| Auth 延迟 | 已登录 token 验证 p95 <100ms（本地验签，不含首次登录交互） | SDK/服务端埋点 |
| Meta API 延迟 | p95 <300ms（指定测试地域、稳定负载） | 多地域压测 |
| 事件摄取 | 正常情况下 99% 已接收事件 5 分钟内进入聚合 | 消息端到端指标 |
| 安全隔离 | 跨产品越权测试 100% 拒绝 | 自动化安全测试 |
| 备份恢复 | D1 恢复演练、R2 配置/关键索引可恢复 | 季度演练 |
| SDK | Web & Workers 兼容；不阻塞首屏 | 体积/性能基准 |
| 成本可观测 | 按产品可展示估算用量与预警 | Dashboard + 每月账单核对 |

- 数据安全：用户密码/密钥加密或哈希存储、最小授权、管理员 MFA、审计、密钥自动轮换能力。
- 隐私合规：地域、数据主体访问/删除/导出、Cookie 和行为事件同意策略须随目标市场评估；不得默认声称符合任何特定法律。
- 失败策略：事件/日志后端故障不能导致业务 API 整体不可用；认证故障应优先安全拒绝；队列积压告警。
- 容灾：定义 RPO/RTO 并经恢复演练确认；上线前必须给出真实演练结果，不在 PRD 中虚构保障。

## 13. 成本与容量模型（必须上线前基准验证）

核心费用驱动因素：Workers 请求及 CPU、D1 查询/存储、R2 容量/操作、Queues 读写、Workers Logs 数据量、Analytics Engine 写入/查询、邮件短信供应商费用、WAF/风控、外部监控。

按产品和环境统计：

- 月活用户数、Auth 登录和刷新次数
- API 总调用次数 / 平均 CPU
- Storage 使用字节数 / 上传下载请求
- Logs 上报数量、日志大小和保留天数
- 事件数 / 日、事件平均尺寸、聚合查询次数
- 失败重试率、DLQ 比例

**规模规划原则**：事件与日志量与活跃用户数并非线性等同；禁止使用“10 万 MAU 必定花 X 美元”作为容量承诺。用 1K、10K、100K DAU 三档模拟多种每用户事件数，结合实时 Cloudflare 定价和压测再做预算。

## 14. POC 验证计划（v2.2：POC-1 / POC-2 获准本地实施）

### POC-0 — 方案评审与准入（纸面设计）

- 明确每个部署唯一平台、多个产品的实体与权限边界；保留产品自行管理业务数据库这一硬约束。
- 选出 1～2 套成熟 OIDC/认证引擎候选，列出其在 Workers 环境的兼容性、存储适配、许可、迁移/锁定风险与安全要求。
- 形成 Apple / Google 开发者账号、域名、回调配置、邮件服务等**未来执行时**的前置依赖清单；本阶段不申请、不配置。
- 明确四类登录的状态图、账号绑定冲突策略、匿名身份不可恢复风险及跨产品授权流程。
- 产出拟议 API 契约、数据隔离矩阵、隐私策略和试验预算上限。

### POC-1 — 认证核心技术可行性（待另行授权实施）

- 在隔离的非生产环境验证 Email/Password、Google、Apple、匿名四条登录链路以及注销/刷新/吊销。
- 验证匿名 → Email / Google / Apple 升级后全局 ID 稳定，账号冲突拒绝静默合并。
- 使用两个虚拟产品 A/B 验证统一身份、不同 membership、不同 audience 及重定向 SSO。
- 压测 D1 会话/凭证写入与 token 验证路径；记录兼容性问题和认证方案选择结论。

### POC-2 — 最小公共能力链路（待另行授权实施）

- Storage：R2 私有直传、签名下载、路径隔离、配额拒绝和删除。
- Logs：服务端结构化日志 / 浏览器错误，经队列归档，按 request_id 定位。
- Analytics：Web SDK 采集事件、批量摄取、简单 DAU / 事件次数展示和环境隔离。
- Console：可配置两个产品与环境，显示最小用量与安全审计事件。

### POC-3 — 评审结论与止损关卡

- 出具功能通过/失败矩阵、延迟/成本实测、鉴权安全问题、未完成项和是否进入 MVP 的建议。
- **通过门槛**：所有 P0 登录方式均能演示；跨产品 token 越权测试无通过；匿名升级无身份丢失或静默并号；其他三项基础能力各至少有一个端到端成功与失败用例。
- **停止/调整条件**：成熟认证引擎无法满足 Cloudflare Workers 安全兼容性、Apple 登录限制不可接受、账号绑定存在可利用的接管风险、D1 关键写入性能不达标、成本超出预定试验预算。优先调整 IdP/存储方案，不自行发明认证协议。
- POC 结论通过并不等于生产上线；正式 MVP 需要独立的安全审计、可恢复备份、监控与发布验收。

## 15. POC 验收清单（拟议测试；尚未执行）

- [ ] 新建两个产品 A、B，分别配置 prod，创建并分配管理员；B 管理员无法读取 A 私有数据。
- [ ] 用户 U 只注册一次，先登录 A，再通过 SSO 登录 B；全局 ID 一致，membership 独立。
- [ ] Email / Password 注册、验证、重置与登录均可行。
- [ ] Google 和 Apple 登录完成真实授权回调验证（使用非生产测试配置），同一 provider subject 不创建重复全局账号。
- [ ] 匿名登录获得稳定会话与全局 ID；升级至 Email / Google / Apple 时保留身份及原有产品关联。
- [ ] 已被其他账号绑定的 provider 凭据不能被自动合并；错误、取消授权、回调重放有可验证的拒绝结果。
- [ ] A 的 access token 调用 B 的私有资源得到 401/403，且无信息泄露。
- [ ] 密码重置、会话失效、refresh token 重放、密钥轮换与撤销测试通过。
- [ ] A 上传私有文件成功，B 用户无法读取；到期 URL 拒绝，文件删除可审计。
- [ ] 两产品各上传日志、浏览器错误、行为事件；后台严格隔离并能按环境筛选。
- [ ] 事件重复提交测试符合定义的去重语义；队列故障与 DLQ 恢复演练通过。
- [ ] 普通 Web App 与 Web Game 均可通过同一 SDK/HTTP API 运行；业务表不需要向平台注册。
- [ ] 用户导出、删除申请可以追踪，服务端实际清理行为有日志和验证结果。
- [ ] 压测、成本警报、备份演练、最低安全基线完成。

## 16. 风险与应对

| 风险 | 影响 | 对策 |
|---|---|---|
| 自建身份提供者复杂，易有安全漏洞 | 极高 | 严格采用成熟 OIDC 实现、单独威胁建模与安全审计；若 Workers 不满足兼容性，优先改用可信托管 IdP 作身份引擎，平台仍统一账号目录与产品授权 |
| 单一 D1 认证库遭遇写入瓶颈 | 高 | 事前压测、减少每次请求写库、会话策略优化、身份数据迁移抽象 |
| 日志/事件量爆发 | 高 | 采样、批量、配额、Queues、R2 分区、告警与成本阈值 |
| 统一身份导致隐私边界模糊 | 高 | 产品级 audience + membership；跨产品画像默认关闭；分权与同意管理 |
| 预签名 URL 泄露 | 中高 | 短有效期、特定对象/操作、私有默认、敏感对象代理授权、必要时一次性语义在应用层实现 |
| 用户删除后残留备份/归档 | 高 | 制定可执行保留期与删除计划，明确备份滞后期与例外情况 |
| 单点平台故障影响多个产品 | 高 | 缓存与降级界限、事故预案、运行监控、备份和迁移路径 |

## 17. 产品负责人决策记录（已确认；其余按建议执行）

| 编号 | 决策 | 当前结论 | 状态 |
|---|---|---|---|
| D01 | 覆盖范围 | **每个部署一个平台，多个产品**；不对外经营多租户 BaaS（v3.0：开源后由各运营者自行部署） | 已确认，v3.0 更新 |
| D02 | 登录方式 | **Email/Password、Google、Apple、匿名登录和升级/绑定全部 P0** | 已确认 |
| D03 | 认证引擎 | 先做 Workers 兼容、安全与成本 POC；优先成熟方案，不从零实现 OAuth/OIDC | 按建议定案，POC 再选型 |
| D04 | SSO 体验 | 统一身份域 + 标准跳转式授权；产品级 audience，不使用跨域共享 Cookie 捷径 | 按建议定案 |
| D05 | 隐私边界 | 产品间行为明细默认隔离；不默认构建跨产品用户画像 | 按建议定案 |
| D06 | 分析留存 | 设计默认 90 天查询窗口；长周期原始事件归档为按需选配 | 按建议定案 |
| D07 | 日志查询 | 初期结构化检索，不建设全文索引平台 | 按建议定案 |
| D08 | 开放策略 | v3.0：开源（Apache-2.0），可自部署；仍不做托管 SaaS、第三方入驻和计费 | 2026-11-03 更新 |
| D09 | 当前工作授权 | ~~只完善 PRD~~ → v2.2：本地实施 POC-1 / POC-2 → v3.0：开源，可自部署 | 2026-11-03 更新 |
| D10 | 云资源与真实凭据 | v3.0：由每个运营者在自己的账号创建与配置（`pnpm platform:deploy`）；项目开发过程中的远程操作仍需维护者另行确认 | 2026-11-03 更新 |
| D11 | 认证引擎 | 首选 Better Auth（自托管于 Workers，D1 存储），Phase 0 技术验证不通过时改用 OpenAuth 或可信托管 IdP（§19.1） | 按建议定案，待 Phase 0 验证 |
| D12 | Worker 拓扑 | POC 收敛为 identity / api / consumer 三个 Worker | 按建议定案 |
| D13 | 邮件供应商 | Resend（HTTP API），由 identity 的 `resendEmailAdapter` 发送验证、重置与已注册提醒邮件（API key 为 Worker secret `RESEND_API_KEY`，发件地址为变量 `EMAIL_FROM`）；v3.0：部署方可选配置 | 2026-10-09 选定 |
| D14 | 平台名称 | v3.0：部署时配置（`PLATFORM_NAME` / `VITE_PLATFORM_NAME`），用于登录页、邮件、TOTP issuer、控制台；代码与协议标识不含任何部署的品牌 | 2026-11-03 确认 |
| D15 | 第一个管理员 | v3.0：部署脚本生成随机密码，经一次性的初始化接口创建 owner（§20.3）；不提供网页安装向导（避免“谁先访问谁成为管理员”） | 2026-11-03 确认 |
| D16 | 管理员 MFA | v3.0：TOTP 默认可选；部署开关 `REQUIRE_ADMIN_2FA=true` 时强制（§19.11） | 2026-11-03 确认 |
| D17 | 许可证 | Apache-2.0 | 2026-11-03 默认，公开发布前可改 |
| D18 | v3.1 范围 | 运维与发布、邮件与注册模式、Passkey / Magic link、品牌与登录页多语言、用户管理、Webhook、数据采集增强、漏斗 / 留存 / 属性分组、原始事件存档与导出（§21）；本轮不做真实部署验证 | 2026-11-04 确认 |

### 尚需在 POC 设计评审中确认的技术细节（非产品方向待决）

- Google/Apple 所需域名与开发者资质、测试账号、回调白名单等准入条件。
- 匿名身份的恢复政策：未绑定且丢失会话时默认不可恢复；绑定冲突须有显式人工/用户可验证处理路径。
- 认证引擎候选、Workers 兼容验证标准、IdP 数据可迁移性及成本上限。
- 实际日志/分析数据留存与删除的合规要求，按目标市场另行审查。

## 18. 官方技术参考（访问时间 2026-10-08）

- Cloudflare D1 Limits: https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare Workers Logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Cloudflare R2 Presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- Cloudflare Queues Batching and Retries: https://developers.cloudflare.com/queues/configuration/batching-retries/
- Cloudflare Workers Analytics Engine Limits: https://developers.cloudflare.com/analytics/analytics-engine/limits/
- Cloudflare Workers Analytics Engine: https://developers.cloudflare.com/analytics/analytics-engine/
- Cloudflare `cf` CLI: https://developers.cloudflare.com/cf/
- Cloudflare Workers Vitest integration: https://developers.cloudflare.com/workers/testing/vitest-integration/
- Better Auth: https://www.better-auth.com/docs （插件 API 随版本变化，以 Phase 0 锁定版本的文档为准）

## 19. v2.2 技术规格补充（实施前必须明确的细节）

v2.1 定下了产品边界，但下列细节没写，实施时会被各个模块各自猜测。本节给出 POC 默认值。标注“初始值”的数字可以配置，要在 POC-3 依据实测结果复核。

### 19.1 认证引擎选型与验证门槛

| 候选 | 角色 | 理由 / 风险 |
|---|---|---|
| **Better Auth**（首选） | 自托管于 identity Worker，D1 存储 | 覆盖 Email / Password、Google、Apple、Anonymous（含 `onLinkAccount`）、JWT / JWKS，并提供 OAuth 2.1 / OIDC Provider 插件；风险是插件组合（Anonymous × OIDC Provider × 多 audience）在 Workers 上没有官方示例，插件 API 也在随版本变化 |
| OpenAuth（备选 1） | Workers 原生 OAuth 2.0 issuer | 天然适配 Workers；匿名登录与账号绑定需要自己补，工作量更大 |
| 托管 IdP（备选 2） | 身份引擎外包，平台保留用户目录与 membership | 安全负担最低；需要外部账号和费用，受 D10 约束，本次不实施 |

**Phase 0 验证门槛**（全部满足才继续使用 Better Auth）：

1. 在 Workers 运行时（`nodejs_compat`）下，通过 D1 适配器完成注册、登录和会话持久化。
2. 能为指定 client 签发 `aud` = 该产品环境 client_id 的 access token，并通过 JWKS 验签；A 的 token 被 B 的校验拒绝。
3. Authorization Code + PKCE 全流程可跑通，包括 state / nonce 校验。
4. 匿名用户绑定 Email / Google 后 `user_id` 不变；凭据已属于其他用户时返回冲突，不合并。
5. refresh token 轮换，旧 token 被重放时撤销整个 family（不满足时由平台在引擎外补实现）。
6. 密码哈希采用引擎内置的成熟实现（scrypt / argon2 系），在 Workers CPU 限制内完成。

任一条无法满足且无法在引擎外以小范围代码补齐，即按 §14 POC-3 的止损条件评估是否切换备选，**不自行实现 OAuth 协议**。

### 19.2 POC 技术栈与 Worker 拓扑

- 语言 / 工具：TypeScript（strict）、pnpm workspace、Node ≥ 22.18。
- Cloudflare 工具链：新项目使用 `cf` CLI 与 `cloudflare.config.ts`；测试使用 `@cloudflare/vitest-plugin`（Workers 运行时内测试）。若 Phase 0 证实两者不兼容，则回退到 `wrangler.jsonc` 并在 CLAUDE.md 记录原因。**Phase 0 结论（2026-10-08）**：`@cloudflare/vitest-plugin` 1.3.7 只读取 wrangler 配置，因此已采用 `wrangler.jsonc`。
- HTTP：Hono；入参校验 Zod；对外契约由 `@hono/zod-openapi` 生成 OpenAPI 3.1。
- 数据访问：Drizzle ORM（D1 / SQLite 方言），迁移文件放在 `database/migrations`。
- 控制台：React + Vite SPA（作为平台的保留 OIDC client `platform_console`）。登录 / 授权 / 账号绑定页面由 identity Worker 服务端渲染（Hono JSX），以缩小攻击面。

| Worker | 职责 | 绑定 |
|---|---|---|
| `identity` | OIDC issuer（`/authorize` `/token` `/revoke` `/userinfo` `/jwks.json`、discovery）、登录 / 注册 / 绑定 UI、会话 | D1 `platform_db`（含认证限流计数） |
| `api` | `/v1/*`：me、storage、logs、events、admin；JWT 本地验签 | D1 `platform_db`、R2、Queues producer、Rate Limiting |
| `consumer` | Queues 消费（logs / events / audit）、DLQ、Cron（清理、保留期、匿名回收） | D1、R2、Analytics Engine |

POC 只用一个 `platform_db`，按表前缀划分认证与元数据；事件去重表放在独立的 `ingest_db`（见 19.6），避免高频写入影响认证库。

### 19.3 标识符与密钥格式

| 对象 | 格式 | 说明 |
|---|---|---|
| `product_id` | `^[a-z][a-z0-9_]{2,31}$`，创建后不可变 | 例：`product_a` |
| `user_id` | `usr_` + UUIDv7 | 全局唯一，不透露注册顺序以外的信息 |
| OIDC client_id | `{product_id}.{env}` | 例：`product_a.prod` |
| Access token audience | `urn:platform:{product_id}.{env}` | 客户端以 RFC 8707 `resource` 参数请求；认证引擎只接受绝对 URI 作为 `aud`（Phase 0 CR-1） |
| Publishable key | `pk_{env}_` + 24 字节 base62 | 公开，只用于识别产品和环境 |
| Service key | `sk_{env}_` + 32 字节 base62 | 只显示一次；存 SHA-256 哈希；带 scope 和 `revoked_at` |
| request_id | `req_` + UUIDv7 | 每个响应都带 `x-request-id` |

### 19.4 Token、会话与 SSO 参数（初始值）

- access token：JWT，非对称签名（以引擎支持为准，首选 EdDSA，次选 ES256），**15 分钟**；header 带 `kid`。
- Claims：`iss`、`sub`（user_id）、`aud`（`urn:platform:{product_id}.{env}`；授予 `openid` 时引擎会额外附加 `{iss}/api/auth/oauth2/userinfo`，此外不允许出现其他成员）、`typ=at+jwt`、`exp`、`iat`、`jti`、`sid`（平台会话）、`pid`（product_id）、`env`、`anon`（boolean）、`scope`；代登录期间另有 RFC 8693 `act`（`{ "sub": "<owner user_id>" }`，§21.5.2）。不放邮箱等个人信息（需要时调用 `/userinfo`）。
- refresh token：opaque，**30 天滑动过期**，每次使用都轮换；旧 token 重放时撤销该用户在**同一 client** 下的全部 refresh token（引擎行为，比单个 family 更严格），并写安全审计事件；身份域会话不随之撤销，避免影响其他产品的 SSO（Phase 0 决定）。
- 身份域会话：HttpOnly + Secure + `SameSite=Lax` Cookie，仅限身份域，**7 天**；敏感操作（绑定 Provider、改密码、删除账号）要求 **5 分钟内**完成过再认证。
- 签名密钥轮换：新 `kid` 先发布到 JWKS，旧 key 至少保留 access token TTL + 时钟偏差（30 分钟）后再下线。
- 产品停用：立即拒绝新的授权和 refresh；已签发的 access token 最长存活 15 分钟。如需立即生效，api Worker 在校验时查询产品状态，查询结果缓存不超过 60 秒。
- Web SDK token 存储：access token 只放内存；refresh token 默认放内存，可配置为 `sessionStorage`。对安全敏感的产品推荐 BFF 模式（`@z-cloudbase/server` 提供 BFF helper）。
- 移动端（P0）：使用系统浏览器 + PKCE + 自定义 scheme / Universal Link 回调（RFC 8252）。原生 Google / Apple SDK 的 id_token 直接交换列为 P1。

### 19.5 统一错误格式

```json
{ "error": { "code": "forbidden_product", "message": "...", "request_id": "req_...", "retryable": false, "details": {} } }
```

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_request` / `validation_failed` | 参数或 Schema 错误，`details` 列出字段 |
| 401 | `unauthenticated` / `token_expired` / `invalid_token` | 缺少 token、token 过期或验签失败 |
| 403 | `forbidden` / `forbidden_product` / `product_disabled` / `membership_required` / `user_banned` / `impersonation_restricted` | 无权限、跨产品访问、产品已停用、受限产品无准入、用户已被平台封禁（§21.5.1）、代登录 token（带 `act`）调用了只允许用户本人执行的操作（§21.5.2） |
| 404 | `not_found` | 资源不存在，或无权知道它是否存在（防枚举） |
| 409 | `identity_conflict` / `idempotency_conflict` / `conflict` | 凭据已属于其他账号；相同 Idempotency-Key 但请求体不同；其他重复或状态冲突（如管理端重复创建产品、存储桶、事件 schema 或团队角色） |
| 413 | `payload_too_large` | 超过 §19.6 的上限 |
| 422 | `quota_exceeded` / `unsupported_type` | 配额或类型不符 |
| 429 | `rate_limited` | 带 `Retry-After`，`retryable: true` |
| 5xx | `internal` / `unavailable` | `retryable` 按情况设置 |

OIDC 标准端点不使用此格式，按 RFC 6749 / OIDC 规范返回错误。`Idempotency-Key` 有效期 24 小时，作用域为（凭证, 路由）。

### 19.6 限额与默认值（初始值）

| 项 | 默认 |
|---|---|
| 事件批次 | ≤ 100 条，且 ≤ 256 KB；单条 `properties` ≤ 8 KB、≤ 50 个键、只允许标量值 |
| 事件时间偏差 | `occurred_at` 不早于 7 天前，不晚于 5 分钟后，超出则拒绝该条 |
| 事件去重 | `(product, env, event_id)` 在 **24 小时**窗口内去重；去重表放 `ingest_db`，由 Cron 清理过期记录 |
| 部分失败 | 批次返回 `accepted` / `rejected[]`（含 index 与 code），合法事件不因同批其他事件失败而丢弃 |
| 日志批次 | ≤ 100 条，且 ≤ 512 KB；单条 ≤ 16 KB；`attributes` ≤ 30 个键；浏览器错误报告 ≤ 8 KB |
| 敏感字段过滤 | 键名匹配 `password\|secret\|token\|authorization\|cookie\|api_key` 的值替换为 `[REDACTED]` |
| 上传预签名 | 10 分钟；下载预签名默认 5 分钟，最长 1 小时 |
| 单对象上限 / 产品容量 | 默认 50 MB / 5 GB，可按产品配置 |
| 认证限流 | 登录 / 注册：每 IP 10 次 / 分钟，每账号 5 次 / 分钟；连续失败触发 Turnstile。计数为 D1 固定窗口计数器（`auth_rate_counters`，键只存哈希），超限返回 429 + `Retry-After`（2026-10-09：Cloudflare Rate Limiting 绑定在 staging 实测按机器本地计数，55 次请求只拦 1 次，不能满足精确限额） |
| 采集限流 | 每 publishable key 每分钟 600 个批次 |
| 用户属性（v3.1，§21.7） | 每个用户每个产品环境 ≤ 20 个键、JSON ≤ 2 KB；键 `^[A-Za-z0-9_]{1,64}$`；字符串值 ≤ 256 字符 |
| 分析保留期（v3.1，§21.8） | `ANALYTICS_RETENTION_DAYS` 默认 90（1–90）；漏斗 2–5 步、转化窗口 ≤ 30 天；留存 day ≤ 31 期、week ≤ 13 期；分组 ≤ 50 行；明细每页 ≤ 100 条；自定义维度 ≤ 3 个 |
| 原始事件归档与导出（v3.1，§21.9） | `ARCHIVE_RETENTION_DAYS` 默认 90（1–3650）；单次导出 ≤ 31 天且 ≤ 2,000 个归档对象 |

### 19.7 账号绑定与冲突状态机

```text
Anonymous ──link(Email|Google|Apple)──> 凭据未被占用？──是──> 绑定到当前 user_id，anon=false（ID 不变）
                                         └─否──> 409 identity_conflict（不合并，匿名账号保持不变）
                                                 └─ 用户可选择“登录已有账号”：
                                                    匿名账号原样保留至回收期；平台不迁移数据，
                                                    由产品后端在持有两个有效 token 时自行决定业务数据迁移
Registered ──link(Provider)──> 要求 5 分钟内再认证 + state/nonce/PKCE ──> 同上冲突检查
任何情况下：邮箱相同 ≠ 同一人；不得基于邮箱自动合并（Apple private relay 尤其如此）
```

- 匿名用户回收：既无已绑定凭据、又 **30 天**无活动的匿名用户由 Cron 进入删除流程（§19.8）。可按产品配置。
- 解绑：至少保留一种可登录的凭据；不能解绑最后一种。

### 19.8 删除与导出语义

- **退出产品**：立即将 membership 设为 `revoked`，撤销该产品 audience 下的 refresh token；之后由后台删除该产品下归属此用户的 Storage 对象，并删除这条 revoked 记录。此后用户可以重新登录、再次加入开放产品。全局账号保留。
- **管理员撤销 membership**：`revoked` 对管理员是终态，不能改回 `suspended` 或 `active`；这条记录会一直保留，用户无法重新加入。
- **删除全局账号**：先进入 7 天冷静期（可撤回；后台开始处理后不可撤回），之后级联：撤销全部会话和 token → 删除全部 membership（产品 API 立即拒绝该用户）→ 删除 Storage 对象与历史导出文件 → 删除凭据，在 `users` 中只保留墓碑（id、deleted_at），以便审计关联。
- **Analytics 中的身份**：事件只写入 `user_key = HMAC(user_id, product_salt)`，不写原始 `user_id`。Analytics Engine 的数据无法逐条删除，依赖 90 天自然过期；R2 归档不重写，删除后的导出排除该用户，分区到保留期后整体删除（v3.1，§21.9）。PRD 承诺的删除完成时间 = 冷静期 + 最长 90 天，必须在隐私政策中如实说明。
- **导出**：生成 JSON（账户资料、membership、Storage 对象清单；v3.1 起含第二因素的元数据：是否启用 TOTP、Passkey 的名称 / 创建时间 / 设备类型 / 是否云同步，不含 TOTP 密钥、备用码和 Passkey 公钥），写入私有 R2 路径，用一次性短期链接下载。
- **发起位置**：删除全局账号（含冷静期内撤回）与导出申请只能在身份域的用户中心发起和下载，凭身份域会话 Cookie，并要求 5 分钟内完成过再认证（§19.4）；产品 API 的 access token 既不能证明近期认证，也无权代表跨产品数据，因此产品 API 只提供“退出产品”及查询本产品的退出申请。导出通过一次性下载链接交付（§19.11）。

### 19.9 控制台认证与 RBAC

- 控制台是保留 client `platform_console`，管理员走同一身份域登录；TOTP（含备用码）默认可选，部署开关 `REQUIRE_ADMIN_2FA=true` 时控制台授权强制要求（§19.11，v3.0）。已启用 TOTP 的用户，登录产品时引擎同样会要求验证码；未启用 TOTP 的产品用户不受影响。
- 角色：`owner`（平台）、`operator`（平台，只读排障，不可读文件内容）、`product_admin` 与 `product_developer`（scope = product_id，可选再限 env）。
- 引导（v3.0）：第一个 owner 由部署脚本经初始化接口创建，密码随机生成、只显示一次（§20.3）；不提供公开注册为管理员的入口。
- 每个 admin 路由都在服务端做 RBAC 检查并写审计；跨产品越权测试覆盖每个 admin 路由。

### 19.10 本地开发与测试替身

| 依赖 | 生产 | 本地 / 测试 | 何时验证生产路径 |
|---|---|---|---|
| Google / Apple | 真实 OIDC | 仓库内 Mock OIDC Provider（可签发带 `email_verified`、private relay 邮箱、错误 nonce 等场景的 id_token） | 拿到开发者账号后（D10） |
| 邮件 | 部署选择的发送方式（§21.2：Resend HTTP / SMTP / Cloudflare `send_email` 绑定） | `outbox` Adapter，邮件写入 D1 表供测试读取；SMTP 与 `send_email` 另用本地假对端 / 假绑定在协议边界测试 | 远程部署 |
| R2 预签名 | S3 兼容预签名（`aws4fetch`） | Miniflare 没有 S3 端点，改用 `dev` 模式专用的 Worker 签名上传路由，只在本地 / 测试注册 | 远程部署 |
| Analytics Engine 查询 | AE SQL API | 实现同一 `AnalyticsQuery` 接口的 D1 替身 | 远程部署 |
| 认证限流 / 采集限流 / Turnstile | 认证：D1 计数器；采集：Cloudflare Rate Limiting 绑定（软限制）；Turnstile siteverify | 同一 D1 计数器（Miniflare）/ 本地绑定模拟 / Turnstile 官方测试 key | 远程部署 |

本地 POC 通过不等于 §14 POC-3 通过：凡是依赖替身的条目，都必须在验收矩阵中标记为“本地已验证 / 远程待验证”。

### 19.11 补充功能规格（2026-10-09）

> 产品负责人已于 2026-10-09 确认以下行为：Turnstile 的失败计数口径、事件名已登记但版本未登记时的处理、启用 TOTP 的用户登录产品时也要输入验证码、扩展名边界规则。

| 功能 | 规格 |
|---|---|
| Turnstile | v3.0：可选，部署方配置 site key 与 secret 后启用；未配置时不触发挑战，只有认证限流。启用时：同一账号或同一 IP 在 15 分钟内认证失败达到 3 次后（失败包括：密码错误的登录，按账号和 IP 计数；无效或过期的重置 token，只按 IP 计数。申请重置链接不计入，因为该接口对已注册和未注册的邮箱响应相同，以防枚举），登录、注册、找回密码、匿名升级到 Email 都必须附带有效的 Turnstile token。服务端通过验证接口 Adapter 校验：生产调用 siteverify；本地 / 测试使用替身，不访问网络。失败计数只保存账号哈希和 IP 哈希。 |
| 管理员 MFA | v3.0：TOTP 默认可选，管理员可在身份域账号页自行开启。已开启 TOTP 的管理员，控制台 client `platform_console` 的授权要求本次身份域会话通过了第二因素（v3.1：经用户验证的 Passkey 登录也算，见 §21.3）。部署开关 `REQUIRE_ADMIN_2FA=true` 时，未启用 TOTP 的管理员先被引导到身份域的 MFA 设置页（提供备用码）。产品 client 不受影响。丢失认证器时由运营者执行 `platform:reset-admin --disable-2fa`（§20.3）。 |
| 一次性导出链接 | 用户中心为已完成的导出生成下载链接，有效期 15 分钟，只能使用一次（服务端记录消费状态）。生成链接仍要求 5 分钟内重新登录过。生成和下载都写审计。 |
| 每日上传配额 | 按产品环境、按 UTC 日统计当天创建的上传字节数（默认 1 GB，可配置），超过则返回 `quota_exceeded`。 |
| 扩展名白名单 | 按产品环境配置，与 MIME 白名单同时生效。白名单为空表示不限制。文件名必须带扩展名，按最后一个扩展名、小写比较；点开头的隐藏文件（如 `.txt`）和以点结尾的文件名都视为没有扩展名。 |
| 事件属性 Schema | 产品为 `(event_name, schema_version)` 注册属性 Schema（受限子集：标量类型、必填、长度、枚举、最小值和最大值、是否允许额外属性）。违反已登记 Schema 的事件：dev / staging 接受并返回 warning，prod 拒绝该条（`schema_violation`）。事件名或版本未登记，按 unknown event 规则处理；也就是说，事件名已登记但版本未登记时，prod 下 `unknown_event_policy=reject` 也会拒绝。 |
| Web SDK 自动采集 | `autocapture: { pageViews, sessions }`，默认关闭。`page_view` 在初始化时、`pushState` / `replaceState` / `popstate` / `hashchange` 时触发，属性为 path、referrer、title。会话在 30 分钟无活动后轮换 `session_id`，并产生 `session_start` 事件。 |

---

**PRD 结论**：本平台是“平台账号为根、产品为授权与数据隔离单位”的轻量基础后端；只提供 Auth、Storage、Logs、Analytics、SDK 和必要管理功能。它不是游戏后端，也不是通用数据库托管产品。产品业务数据库与表由各产品独立设计，不进入平台的管理范围。

> **执行边界（v3.0）**：本仓库的开发与测试只在本地进行（Miniflare）；任何部署由运营者在自己的 Cloudflare 账号上用 `pnpm platform:deploy` 执行。项目维护者的远程资源与凭据不属于本仓库。

## 20. v3.0 开源与自部署

### 20.1 定位

- 软件开源（Apache-2.0）。一个部署 = 运营者 Cloudflare 账号里的一组资源 + 三个 Worker + 控制台静态站点，服务一个平台和它的多个产品。
- 部署之间完全独立：各自的 issuer、密钥、数据；同一账号可以用不同资源前缀部署多套。

### 20.2 部署（`pnpm platform:deploy`）

| 项 | 规格 |
|---|---|
| 输入 | `--admin-email`（首次必填）、`--name`（显示名，默认 z-cloudbase）、`--domain`（可选；有则使用 `id.` / `api.` / `console.` 三个 custom domain，否则用账号的 workers.dev 子域）、`--prefix`（资源前缀，默认 `z-cloudbase`）、`--require-admin-2fa`、`--account-id`、`--location`、`--dry-run` |
| 资源命名 | Worker `{prefix}-identity/-api/-consumer/-console`；D1 `{prefix}-platform`、`{prefix}-ingest`；R2 `{prefix}-storage`、`{prefix}-archive`；Queues `{prefix}-logs`、`{prefix}-events` 及 `-dlq`；AE 数据集 `{prefix}_events`（`-` 换成 `_`） |
| 幂等 | 已存在的资源不重建；迁移按 D1 迁移表增量执行；同一命令用于升级。首次的设置保存在 `.deploy/{prefix}.json`（不含密钥，gitignored） |
| 密钥 | identity 的 `AUTH_SECRET` 只在 Worker 不存在时生成一次（之后绝不覆盖：会使全部会话与签名密钥失效）；`SETUP_TOKEN` 每次部署随机生成；其余可选 secret 从运营者的环境变量读取（邮件、Turnstile、Google / Apple、R2 S3 token、AE 查询 token），未提供时保留上次的值 |
| 可选能力 | 未配置邮件：用户邮箱注册与找回密码不可用；未配置 Turnstile：只有认证限流；未配置 R2 S3 token：文件上传 / 下载不可用；未配置 AE 查询 token：事件照常采集，控制台无法出图。部署结束时列出未配置项 |

### 20.3 初始化接口（identity `/setup/*`）

- 鉴权：Worker secret `SETUP_TOKEN` 作为 Bearer token，常量时间比较；没有该 secret 时路由不存在（404）。运营脚本每次使用前都写入新的随机 token，token 不落盘，因此持有它等于持有部署所在的 Cloudflare 账号。
- `POST /setup/install` `{ admin_email, admin_password, console_redirect_uris }`：注册或更新 `platform_console` 的回调地址；**仅当平台还没有 owner 时**，用认证引擎的原语（用户、credential 账号、引擎的密码哈希）创建邮箱已验证的管理员并授予 `owner`，写审计 `ops.owner_granted`。邮箱已属于现有账号时返回 409，绝不提升已有账号。已有 owner 时返回 `admin: "exists"`，不创建、不修改任何账号。
- `POST /setup/reset-admin` `{ email, password, disable_2fa? }`：只对平台团队成员生效；设置新密码、撤销全部会话和产品 token，可选移除 TOTP、备用码与 Passkey（v3.1），写审计 `auth.admin_password_reset`。普通用户走邮件找回。
- 管理员密码至少 12 位；脚本生成 24 位随机密码（去掉易混字符），只在终端显示一次。


## 21. v3.1 扩展（2026-11-04，本地已实施，版本 0.2.0）

范围由产品负责人于 2026-11-04 确认（D18）。每一小节先写规格再改代码；规格写明默认值、限额、错误码、权限与审计动作。真实 Cloudflare 部署验证不在本轮范围（本地已验证 / 远程待验证）。

### 21.1 运维与发布

**`pnpm platform:destroy --prefix <p> [--confirm <p>] [--account-id <id>] [--dry-run]`**

- `--prefix` 必填（不设默认值，避免误删默认部署）。资源名全部来自 `resourceNames(prefix)`。
- 先打印完整计划（账号、每一项资源与对应的 wrangler 命令），然后要求确认：交互终端里手动输入前缀；非 TTY 必须给出与 `--prefix` 完全相同的 `--confirm`，否则拒绝执行。`--dry-run` 只打印计划，不访问远程、不需要登录。
- 删除顺序（依赖方在先）：Worker（`console` → `api` → `consumer` → `identity`，`wrangler delete`，随之移除其 custom domain / 路由与 secret）→ 四个队列上的 consumer（`queues consumer remove`）→ 四个队列 → 两个 D1（`d1 delete -y`）→ 两个 R2 bucket → `.deploy/<prefix>.json`。已不存在的资源按“已删除”处理，所以失败后可以重跑同一条命令。
- wrangler 的能力边界（wrangler 4.148 的 `--help` 核实，2026-11-04）：
  - R2 bucket 必须为空才能删除，wrangler 没有“列出 / 批量删除对象”的命令。做法：先尝试 `r2 bucket delete`；遇到“非空”时给该 bucket 加一条生命周期规则 `destroy-expire-all`（全部对象 1 天后过期、未完成的分片上传 1 天后中止），把它标为“待清空”并提示约 24 小时后重跑同一条命令。仍有 bucket 待清空时保留 `.deploy/<prefix>.json`，退出码为 1。运营者也可以自己用 S3 兼容工具清空后立即重跑。
  - Analytics Engine 数据集无法删除（没有对应 API）：无写入后按保留期（90 天）自动过期，计划里只列出数据集名称。
  - D1 删除不可恢复，同时失去 Time Travel 历史；计划里提示先用 `wrangler d1 export` 备份。
  - 自定义域名对应的 DNS 记录是否随 Worker 一并清除，本仓库未在真实账号验证（远程待验证）；结束时提示运营者在 Cloudflare 控制台检查。
- 退出码：全部完成 0；有失败或待清空项 1。

**限流命名空间**：`ratelimits.namespace_id` 在 Cloudflare 账号内唯一（正整数字符串，文档未给出上限）。部署脚本为生成的 api 配置设置 `namespace_id = 1000000 + (SHA-256(prefix) 前 4 字节 mod 2000000000)`，同前缀稳定、不同前缀不同（碰撞概率约 5×10⁻¹⁰）；仓库内的本地值 `2001` 不变。

**升级前的 D1 恢复点**：已存在的部署在应用迁移前，对 platform / ingest 两个库执行 `wrangler d1 time-travel info <db> --json`，取得当前 bookmark，写入 `.deploy/<prefix>.json` 的 `restorePoints`（时间、升级前的版本与 commit、两个 bookmark）。迁移失败时和部署结束的摘要里都打印 `wrangler d1 time-travel restore <db> --bookmark=<b>`（破坏性：覆盖当前数据；Free 套餐保留 7 天，Paid 30 天；还原后需把代码回到记录的 commit 再部署）。首次创建（库刚建好）与 `--dry-run` 不记录；取不到 bookmark 时只警告、不阻止升级。

**版本与发布**
- 版本号与根 `package.json` 的 `version` 一致（v3.1 为 `0.2.0`，与两个 SDK 相同），变更记录 `CHANGELOG.md`（Keep a Changelog）。部署记录 `.deploy/<prefix>.json` 保存 `version`、`commit`（工作区有改动时加 `-dirty`）、`deployedAt`。
- CI（`.github/workflows/ci.yml`，push / PR）：安装（frozen lockfile）、`pnpm -r typecheck`、`pnpm -r test`、`pnpm test:scripts`、`pnpm sdk:pack`；`pnpm test:e2e` 为独立 job。Node 24，pnpm 取自 `packageManager`。依赖更新用 Dependabot（npm 每周分组，github-actions 每周）。
- 发布（`release.yml`，tag `v*`）：校验 tag 与版本一致，构建 SDK tarball，经 npm trusted publishing（GitHub OIDC，无 token）把 `@z-cloudbase/web` 与 `@z-cloudbase/server` 暂存（`npm stage publish`；trusted publisher 不允许直接发布），维护者用 `npm stage approve <id>`（2FA）正式发布；tarball 附到 GitHub Release。0.2.0 首次由维护者本机发布（trusted publisher 只能配置在已存在的包上）。

**本地一条命令开发 `pnpm dev`**：复用 `tests/e2e/local-stack`。状态目录默认 `.wrangler-state`（gitignored）：执行迁移；生成并保存本地 `AUTH_SECRET`（`.wrangler-state/dev-secrets.json`，权限 600，重启后签名密钥仍可解密）；固定端口（identity / api / gateway 8787，控制台 5173，可用 `--port` / `--console-port` 修改）；首次运行创建管理员（随机密码只打印一次）；每次启动都更新控制台回调地址；启动控制台 Vite dev server 指向本地栈；打印 URL；Ctrl-C 停止全部子进程。

**“Deploy to Cloudflare” 按钮的结论（官方文档 https://developers.cloudflare.com/workers/platform/deploy-buttons/ ，访问 2026-11-04）：本仓库不实现，原因如下。**
1. 每个按钮只部署一个 Worker 应用，文档明确“多个 Worker 的 monorepo 需要为每个应用配置各自的按钮”，且子目录部署要求应用“完全隔离在该子目录内，包括依赖”；本仓库有 4 个 Worker，且依赖 workspace 包（contracts、security）。
2. 自动配置的资源类型列表为 KV、D1、R2、Hyperdrive、Vectorize、Secrets Store、Durable Objects、Workers AI、Queues；未列出服务绑定（identity 与 api / consumer 的 `IdentityRpc`）、Analytics Engine、限流绑定。
3. 部署顺序（identity → consumer → api → console）与 secret 的跨 Worker 生成（`AUTH_SECRET` 只生成一次、`SETUP_TOKEN` 每次随机）、R2 CORS、`/setup/install` 创建首个管理员（随机密码打印一次）都不在按钮流程内；D1 迁移只能放进单个 Worker 的 `deploy` 脚本，而本仓库两个库由不同迁移目录共享给多个 Worker。
4. 按钮只支持公开的 github.com / gitlab.com 仓库，并按“拥有者账号”创建克隆，不保证与上游版本升级的关系。
最接近的路径：保持 `git clone` + `pnpm platform:deploy`（一条命令完成资源、迁移、四个 Worker、首个管理员）。若 Cloudflare 将来支持多 Worker / 服务绑定 / 部署后脚本，再重新评估。

### 21.2 邮件发送与注册模式

- 邮件不再只有 Resend 一种：增加至少一种无需第三方 HTTP 服务的发送方式（SMTP 或 Cloudflare 原生发信，以官方文档核实的能力为准）。
- 注册模式（部署配置）：开放注册且要求邮箱验证（有邮件时的默认）、开放注册不验证邮箱、仅邀请注册。

**邮件发送方式**（identity 变量 `EMAIL_TRANSPORT`，发件地址统一用变量 `EMAIL_FROM`；`DEPLOY_ENV=local` 时始终写 D1 outbox）：

| `EMAIL_TRANSPORT` | 配置 | 能力与限制（官方文档，2026-11-04 核实） |
|---|---|---|
| `resend` | secret `RESEND_API_KEY` | 第三方 HTTP API（D13）。未设 `EMAIL_TRANSPORT` 但有 `RESEND_API_KEY` 时按 `resend` 处理（兼容 v3.0） |
| `smtp` | 变量 `SMTP_HOST`、`SMTP_PORT`（默认 465）、`SMTP_USERNAME`；secret `SMTP_PASSWORD` | 经 `cloudflare:sockets` 连接任意 SMTP 服务（库：`worker-mailer`，MIT），Workers Free 可用；Workers 不能连 25 端口。**只支持隐式 TLS（465 端口类）**：该库的 STARTTLS 是“服务器声明支持才升级”，中间人去掉声明即可让凭据明文发送，因此不提供 STARTTLS 选项。TLS 握手与真实投递只能远程验证 |
| `cloudflare` | `send_email` 绑定 `SEND_EMAIL`（部署脚本在选择该方式时生成） | Cloudflare Email Service（Email Sending，Beta）：向任意收件人发信需要 **Workers Paid** 且发件域名已接入 Email Service；Free 套餐只能发给账号内已验证的目标地址，不能用于用户邮件。错误以 `E_*` code 抛出 |

- 未配置任何方式时邮件为“不可用”：依赖邮件的功能按下表关闭，而不是在请求中途失败。发送失败返回 503 `unavailable`（日志不含收件人、密钥或服务器原始应答）。
- 邮件语言：取**触发该邮件的请求**的界面语言（§21.4 的选择顺序）；没有请求上下文时（如控制台创建邀请）取创建者在控制台选择的语言，否则取部署默认语言。平台不额外保存用户语言。

**注册模式**（identity 变量）：

| 变量 | 取值 | 默认 |
|---|---|---|
| `SIGNUP_MODE` | `open`：任何人可创建账号；`invite`：只能凭邀请链接创建 Email / Password 账号；`closed`：不再创建任何账号 | `open` |
| `REQUIRE_EMAIL_VERIFICATION` | `true`：邮箱未验证不能用密码登录（引擎 `requireEmailVerification`，登录时自动补发验证邮件）；`false`：运营者选择不验证 | `true` |

| 能力 | `open` | `invite` | `closed` |
|---|---|---|---|
| Email / Password 注册（`/register`、引擎 `/sign-up/email`） | 可用；但要求验证且邮件不可用时关闭 | 只能凭有效邀请 | 关闭 |
| 游客（匿名，`/guest`、`/sign-in/anonymous`） | 可用 | 关闭（否则匿名账号再绑定邮箱即可绕过邀请） | 关闭 |
| Google / Apple 新用户 | 可用 | 关闭（已绑定的账号照常登录） | 关闭（同左） |
| Magic link 新用户（§21.3） | 可用 | 关闭（已有账号照常登录） | 关闭（同左） |
| 已有账号登录、已有匿名账号升级 | 可用 | 可用 | 可用 |

- 关闭的入口：表单页显示“当前不开放注册”；JSON 调用返回 403 `forbidden`，`details.reason = "signup_closed"`（`/guest` 同）；引擎端点由引擎返回其自身错误。所有新建用户还经过引擎 `user.create.before` 钩子兜底（非 `open` 模式下没有有效邀请的新建一律拒绝）；运营初始化接口（§20.3）不受注册模式影响。
- `REQUIRE_EMAIL_VERIFICATION=true` 且邮件不可用：Email / Password 注册、匿名升级到 Email（`/link/email`）、Magic link 都不可用；需要接受邮箱注册的无邮件部署必须显式设为 `false`。**风险**：不验证时任何人都可以用他人邮箱注册（只能证明知道密码，不能证明拥有邮箱），id_token 的 `email_verified` 为 `false`，产品不得把此类邮箱当作已验证身份；平台本身从不按邮箱合并账号。

**邀请**（`SIGNUP_MODE=invite` 时用于注册；其他模式下也可创建，但只有 `invite` 模式要求它）：

- 数据：D1 `invitations`（迁移 `0015`）：`id`（`inv_` + UUIDv7）、`email`（小写）、`token_hash`（SHA-256，链接 token 为 32 字节随机数 base64url，不存明文）、`delivery`（`email` / `link`）、`created_by`、`created_at`、`expires_at`、`used_at`、`used_by`、`revoked_at`、`revoked_by`。状态由字段推出：`pending` / `used` / `revoked` / `expired`。
- 有效期：`expires_in_days` 1–30，默认 7；只能使用一次（条件 UPDATE 原子占用；注册失败时释放）。
- 管理：identity RPC `createInvitation` / `listInvitations` / `revokeInvitation`；api `POST /v1/admin/invitations`、`GET /v1/admin/invitations`、`DELETE /v1/admin/invitations/:id`，均要求 `platform:manage`（仅 owner；operator 不可见，因邀请含邮箱）。控制台“平台 → 邀请”页。
- 创建规则：该邮箱已有账号 → 409 `conflict`；已有未过期、未使用、未撤销的邀请 → 409 `conflict`（先撤销再建）。邮件可用时链接**只通过邮件发送**（`delivery=email`），兑现即视为证明拥有该邮箱，账号创建为“邮箱已验证”；邮件不可用时链接只在创建响应中返回一次（`delivery=link`），由管理员自行转交，兑现不证明邮箱，若此时 `REQUIRE_EMAIL_VERIFICATION=true` 则拒绝创建（400 `invalid_request`）。
- 兑现：`GET /register?invite=<token>` 显示固定邮箱的注册表单；无效、过期、已用、已撤销都显示同一个“邀请无效或已过期”页面。
- 审计：`invitation.create`、`invitation.revoke`（actor 为管理员，写在 identity，`request_id` 透传）、`auth.invitation_redeemed`（actor 为新用户）。元数据只有邀请 id、`delivery`、有效期，不含 token。
- 列表：按创建时间倒序，`limit` 1–200（默认 50）、`offset`，可按 `status` 过滤。

**部署脚本**：`--signup-mode open|invite|closed`、`--require-email-verification true|false`；邮件从环境变量读取（`EMAIL_TRANSPORT`、`EMAIL_FROM`、`RESEND_API_KEY` 或 `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD`），非密钥设置保存在部署记录中，下次运行不提供时沿用；未配置邮件时在结束时列出。

### 21.3 Passkey 与 Magic link

**Passkey**（Better Auth `@better-auth/passkey` 1.7.15，底层 SimpleWebAuthn；身份域变量 `PASSKEYS`，默认 `true`）：

- RP：`rpID` = `ISSUER` 的主机名，`origin` = `ISSUER` 的 origin（固定，不取请求头），`rpName` = `PLATFORM_NAME`。迁移 `0016` 建 `passkey` 表。
- 注册（账号页 `/account` → “添加 Passkey”）：要求登录且 5 分钟内认证过（引擎 `freshSessionMiddleware`），`attestation=none`，`residentKey=preferred`，**`userVerification=required`**，服务端检查 UV 标志，未验证用户的注册被拒绝。匿名用户不能添加（Passkey 不是升级途径）。
- 注册的第二因素前置条件（v3.1 安全修复）：账号已启用 TOTP 或已有至少一个 Passkey 时，`generate-register-options` 与 `verify-registration` 都要求**本会话在 5 分钟内通过过第二因素**（`twoFactorVerifiedAt` 在再认证窗口内：登录时或 `/two-factor` 步进验证输入了 TOTP / 备用码，或本会话由 Passkey 登录创建），否则 403，code `SECOND_FACTOR_REQUIRED`（提示先在 `/two-factor` 验证或用 Passkey 登录）。原因：社交登录与 Magic link 不经过 two-factor 插件的挑战，若只凭这类会话就能添加 Passkey，拿到用户社交账号的攻击者可先登记自己的 Passkey，再用它“满足”控制台 MFA。账号既没有 TOTP 也没有 Passkey 时，添加**第一个** Passkey 不要求第二因素（此前不存在第二因素，不构成降级），仍要求 5 分钟内认证过。
- 添加成功后，若部署配置了邮件，向账号邮箱发送“账号添加了新的 Passkey”通知（中英双语，取请求语言；尽力而为，发送失败只记日志、不影响注册）。
- 删除：账号页逐个删除，属于敏感操作（5 分钟内认证过，§19.4）。不限制删除最后一个 Passkey（Passkey 只是附加登录方式；账号至少保留一种凭据的规则针对 Provider 解绑）。
- 登录：登录页“使用 Passkey 登录”（可发现凭据，不需输入邮箱）；在 OIDC 授权流程中带上签名的 `oauth_query`，登录成功后由引擎继续本次授权。服务端要求 UV 标志（未验证则 401）。挑战 5 分钟有效、一次性（引擎）。`generate-authenticate-options`（GET，会写挑战）与 `verify-authentication` 计入认证限流（§19.6，按 IP）。
- **管理员 MFA**：经用户验证的 Passkey 本身是多因素（持有设备 + 生物识别 / PIN），因此 Passkey 登录创建的会话记为“已通过第二因素”，满足控制台的 MFA 要求；`REQUIRE_ADMIN_2FA=true` 时，已有 Passkey 的管理员可在第二因素页用 Passkey 完成验证，无需另设 TOTP；没有 TOTP 也没有 Passkey 的管理员仍被引导设置 TOTP，设置页也可改为添加 Passkey。已启用 TOTP 的用户用 Passkey 登录不再要求 TOTP。
- 审计：`auth.passkey_added`、`auth.passkey_removed`（metadata 只含 passkey id）。删除全局账号时一并删除 Passkey。
- 浏览器端仪式脚本由 identity 以同源静态资源 `/assets/passkey.js` 提供（不引入第三方脚本）。

**Magic link**（Better Auth `magicLink` 插件；变量 `MAGIC_LINK`，默认 `true`，但只在邮件可用时出现）：

- 登录页“通过邮件登录”：无论邮箱是否存在、是否允许注册，页面都显示同一“请查收邮件”（防枚举）；限流与密码登录相同（每 IP 10 次 / 分钟、每账号 5 次 / 分钟，§19.6）。
- 链接：token 32 字符随机串，库中只存哈希，**5 分钟**有效，只能使用一次（引擎原子消费）。回调只允许同源路径：`/account`、`/login`（失败页）或本 issuer 的 `/api/auth/oauth2/authorize?...`（继续授权，去掉 `prompt=login`）；其他回调 400。
- 注册模式：只有 `open` 时会为不存在的邮箱创建账号（邮箱已验证）；`invite` / `closed` 下不发送链接。
- 已启用 TOTP 的账号：不发送登录链接，改发一封说明“该账号需用密码 + 验证码或 Passkey 登录”的邮件（邮件持有不能绕过第二因素）。
- Magic link 登录不满足控制台 MFA（与社交登录相同，仍需 TOTP / Passkey 步骤）。
- 审计：不单独记录（与密码登录一致，由会话记录体现）。

### 21.4 品牌定制与登录页多语言

- 品牌：logo、主色、登录页文案，部署配置。
- 登录页（identity UI）中英双语，按浏览器语言选择、可切换。

**品牌**（部署配置；identity 变量与控制台构建变量同源，由 `pnpm platform:deploy` 写入并存入部署记录）：

| 项 | identity 变量 / 控制台变量 | 部署脚本 | 校验 |
|---|---|---|---|
| Logo | `BRAND_LOGO_URL` / `VITE_BRAND_LOGO_URL` | `--logo-url` | 只接受 `https:` 绝对 URL，≤ 2048 字符，不含空白、引号、尖括号、反斜杠 |
| 主色 | `BRAND_PRIMARY_COLOR` / `VITE_BRAND_PRIMARY_COLOR` | `--primary-color` | `#rgb` 或 `#rrggbb` |
| 登录页标语 | `SIGNIN_TAGLINE`（只用于 identity） | `--tagline` | ≤ 200 字符，不含换行；作为纯文本输出（转义） |

- 部署脚本对非法值直接报错；运行时再校验一次，非法值按未设置处理（默认外观），绝不原样输出。HTML 中的值全部经转义；颜色只在通过正则后写入 CSS。
- 应用位置：identity 的全部页面（logo、主色、标语只在登录页）、邮件（HTML 版的 logo 与链接颜色）、控制台（侧栏与登录等待页的 logo、`--primary` 主色）。

**多语言**（identity 页面与邮件，`zh` / `en`）：

- 选择顺序：`?lang=zh|en`（设置 Cookie `zcb_lang`，一年，`SameSite=Lax`，并 302 到去掉 `lang` 的同一地址，避免破坏签名的授权参数）→ Cookie → `Accept-Language`（按 q 值取第一个 `zh*` / `en*`）→ 部署变量 `DEFAULT_LANG`（默认 `en`，部署脚本 `--default-lang`）。
- 每页有中英切换链接；`<html lang>` 随语言变化。文案集中在 `services/identity/src/messages.ts`，用 `defineMessages({ zh, en })`，由编译器保证两种语言 key 一致（与控制台相同）。引擎返回的错误信息原样显示（英文）。
- 邮件语言见 §21.2。

### 21.5 用户管理：封禁、代登录、用户导出

- 封禁 / 解封：平台级，封禁后撤销全部会话与产品 token，所有产品都不能再登录。
- 代登录（impersonation）：只用于排查问题，仅 owner 可用、不可代登录平台团队成员、有时限、全程审计，签发的 token 带标识让产品能识别。
- 用户列表导出（产品级，受 RBAC 约束）。

**实现方式（认证引擎）**：不启用 Better Auth 的 admin 插件。该插件的接口按 `user.role` / `adminUserIds` 授权，会在 `team_members` 之外形成第二套管理员体系；它的代登录也无法表达本节的前置条件（TOTP、原因、目标限制、`act` 声明）。平台用一个自有引擎插件（`services/identity/src/user-admin.ts`）复用同样的引擎原语：用户字段 `banned` / `banReason` / `banExpires` 与会话字段 `impersonatedBy`（与 admin 插件同名，便于将来迁移）、会话创建钩子、`internalAdapter.createSession`、会话 Cookie 与签名 Cookie、OAuth Provider 的 claims 扩展点。

**权限（§19.9 补充）**：新增 RBAC 动作 `users:ban`、`users:impersonate`，只有 `owner` 拥有；`operator` 只读排障，不能封禁或代登录。导出沿用 `users:read`（`owner`、本产品的 `product_admin`）。

#### 21.5.1 封禁 / 解封

| 项 | 规格 |
|---|---|
| 接口 | `POST /v1/admin/users/:user_id/ban` `{ reason, expires_at? }`；`DELETE /v1/admin/users/:user_id/ban`。只接受控制台 token，`users:ban` |
| 参数 | `reason` 必填，1–500 字符（内部备注，不展示给被封禁用户，也不进 Webhook）；`expires_at` 可选，ISO 8601，必须晚于当前时间且不晚于 10 年后；缺省为永久 |
| 目标限制 | 用户不存在或已删除（墓碑）：404 `not_found`。平台团队成员（`team_members` 任意角色）：409 `conflict`，须先移出团队；因此也不能封禁自己。已封禁的用户再次封禁：更新原因与到期时间（200） |
| 生效 | 一次 D1 batch 写入封禁字段、审计 `user.ban` 与 Webhook outbox；随后撤销该用户全部身份域会话和全部产品 refresh token，结束针对该用户的进行中代登录 |
| 拦截点 | ① 会话创建层（引擎 `session.create.before` 钩子）：任何登录方式（密码、社交、匿名升级后的登录、二次验证、以及后续的 passkey / magic link）都无法再创建会话，返回 403，code `BANNED_USER`，message 为“此账号已被封禁”（有到期时间时附上到期时间）；身份域登录页原样显示该消息。② 产品授权、授权码兑换、refresh：`productAccess` 拒绝（`access_denied` / `invalid_grant`，`user is banned`）。③ api 的用户 token 校验：已签发但未过期的 access token（最长 15 分钟）返回 403 `user_banned` |
| 解封 | 幂等，返回 200；只有确实解除时才写审计 `user.unban` 与 Webhook。解封不恢复已撤销的会话，用户重新登录 |
| 到期 | 每次检查时按 `banExpires` 判断；consumer 的 15 分钟 cron 清除已到期的封禁，写审计 `user.unban`（actor 为 system，`metadata.reason = "expired"`）与 Webhook `user.unbanned` |
| 其他 | 已封禁用户不能被加入团队（409 `conflict`）。用户查询接口（`GET /v1/admin/users`）返回 `ban: { banned, expires_at, reason }`，其中 `reason` 只对拥有 `users:ban` 的调用方返回 |

#### 21.5.2 代登录（impersonation）

| 项 | 规格 |
|---|---|
| 发起 | 控制台调用 `POST /v1/admin/users/:user_id/impersonations` `{ reason }`（`users:impersonate`，reason 10–500 字符）。服务端检查：调用者已启用 TOTP（否则 403 `forbidden`，`details.reason = "mfa_required"`）；目标存在且未删除（否则 404）、不是平台团队成员、未被封禁、不是自己（否则 409 `conflict`）。成功时创建一条 `pending` 申请（10 分钟内有效；同一 owner 新建申请会取消他之前未开始的申请），写审计 `user.impersonation.request`，返回 `{ id, url, expires_at }` |
| 确认（“新鲜”的定义） | owner 在浏览器打开身份域的 `url`（`/impersonation/{id}`）。页面只对申请人本人的身份域会话可用，显示目标用户、原因和时长，要求输入当前 TOTP 验证码。“新鲜”= 本次身份域会话在 5 分钟内（§19.4 的再认证窗口）通过了 TOTP；确认表单当场完成这次验证，服务端在创建代登录会话前再次检查 owner 角色、TOTP、目标限制和申请状态。确认表单（`POST /impersonation/{id}/start`）计入认证限流（§19.6，每 IP 10 次 / 分钟）；同一申请累计输错 **5** 次验证码即取消（`status = cancelled`，`end_reason = too_many_attempts`），写审计 `user.impersonation.cancel`（metadata：impersonation_id、reason、failed_attempts），需在控制台重新发起 |
| 会话 | 引擎为目标用户创建一个新的身份域会话，`impersonatedBy = owner 的 user_id`，有效期固定 **60 分钟**，不续期（不随访问滑动；即使浏览器丢弃了“不记住我”Cookie，会话的 `session.update` 钩子也保持原到期时间）；带 `impersonatedBy` 但没有对应的 active 且未到期代登录记录的会话一律视为无效：任何引擎请求（含身份域页面的会话查询）先删除该会话和 Cookie，不等 cron；浏览器的会话 Cookie 换成该会话，owner 原来的会话令牌存入签名 Cookie，结束时恢复（若仍有效）。写审计 `user.impersonation.start`（actor = owner，target = 用户，metadata：impersonation_id、reason、expires_at） |
| 产品 token | 代登录会话经 SSO 取得的产品 access token 和 id token 带 RFC 8693 `act` 声明：`"act": { "sub": "<owner 的 user_id>" }`。签发时代登录已不再有效（到期边界）则拒绝签发（`invalid_grant`），不会签出不带 `act` 的 token。产品可据此识别或拒绝（见集成教程）。代登录期间签发的 refresh token 只在代登录有效期内可用；结束或到期后，这些 token 一律失效（数据库触发器在会话删除时删除它们；refresh 时也会检查） |
| 产品授权范围 | 代登录会话只能授权目标用户**自己登录过**的产品环境（已有 active membership，且 `product_env_users` 有该环境的记录）；其他产品 / 环境一律 `access_denied`。代登录不会替用户加入产品、写入首次进入记录或发出 `user.joined` |
| 平台 API（带 `act` 的产品 token） | 只读与日常写入照常：`GET /v1/me`、`/v1/me/requests`、存储上传 / 列表 / 下载、事件与日志上报。只允许用户本人执行的操作返回 403 `impersonation_restricted`：退出产品（`DELETE /v1/me/membership`）、删除存储对象（`DELETE /v1/storage/objects/:id`），以及以后新增的会改变账号或成员状态、删除用户数据的接口。在此期间写入的审计记录（actor 仍是该用户）在 `metadata.actor_id` 记下代登录的 owner |
| 限制 | 代登录会话不能授权控制台 client（`access_denied`），api 也拒绝带 `act` 的控制台 token；不能修改账号安全设置：引擎只放行会话查询、产品授权与同意、token / userinfo / JWKS、退出，其余（改密码、改邮箱、设置密码、绑定 / 解绑登录方式、TOTP、passkey、删除账号、会话管理、登录）一律 403 `IMPERSONATION_RESTRICTED`；身份域用户中心的数据导出、下载、删除申请与绑定表单同样拒绝 |
| 界面 | 代登录期间，身份域每个页面顶部显示常驻横幅（目标用户、owner、结束时间）和“结束代登录”按钮 |
| 结束 | 横幅按钮（`POST /impersonation/stop`）、退出登录或 OIDC RP 发起的登出（`/oauth2/end-session`，含确认页 `/oauth2/end-session/confirm`）；任何途径删除代登录会话时（引擎 `session.delete` 钩子）都结束对应记录：未到期为 `signed_out`，已到期为 `expired`；到期后由 consumer 的 15 分钟 cron 收尾（会话本身到期即不可用）。写审计 `user.impersonation.stop`，`metadata.end_reason` 为 `stopped` / `signed_out` / `expired` / `target_banned` |

#### 21.5.3 用户导出（产品环境级）

| 项 | 规格 |
|---|---|
| 接口 | `GET /v1/admin/products/:id/environments/:env/users/export[?include_email=true][&after=usr_…]`，`users:read`（本产品），返回 `text/csv; charset=utf-8` 附件 |
| 范围 | 在该环境登录过的用户（`product_env_users`：每个产品环境首次授权时记录，见 §21.6），排除已删除用户；按 `user_id` 升序，每次最多 5000 行；还有更多时响应头 `X-Next-Cursor` 给出下一页的 `after` |
| 列 | `user_id, is_anonymous, account_created_at, env_first_seen_at, membership_status, product_joined_at, product_last_seen_at, providers, banned`；`include_email=true` 时追加 `email`（匿名用户为空）。`providers` 用 `;` 分隔。不导出姓名、头像、IP、会话、token |
| 安全 | 单元格以 `= + - @` 或制表符 / 回车开头时前置 `'`，防止表格公式注入。写审计 `user.export`（env、行数、是否含邮箱、after） |

### 21.6 产品 Webhook

- 平台把与产品相关的用户事件（例如用户首次进入产品、游客升级、用户删除）推送到产品配置的 HTTPS 地址；签名、重试、投递记录。

**端点配置**（每个产品环境独立）：

| 项 | 规格 |
|---|---|
| 接口 | `GET/POST /v1/admin/products/:id/environments/:env/webhooks`；`PATCH/DELETE …/webhooks/:webhook_id`；`POST …/webhooks/:webhook_id/rotate-secret`；`POST …/webhooks/:webhook_id/test`；`GET …/webhooks/:webhook_id/deliveries` |
| 权限 | 读（列表、投递记录）：`webhooks:read` = owner、operator、本产品的 product_admin 与 product_developer。写（创建、修改、删除、轮换、测试）：`webhooks:manage` = owner、本产品的 product_admin；product_developer 只能写 dev / staging（与密钥管理一致）。其他产品的端点一律 404 |
| 字段 | `url`（≤ 2048）、`description`（≤ 200，可选）、`event_types`（至少一个可订阅类型）、`enabled`（默认 true）。每个产品环境最多 **10** 个端点，超出 422 `quota_exceeded` |
| URL 规则 | 必须 `https://`；不允许 URL 中带用户名密码；主机不能是 `localhost` / `*.localhost`，不能是私有、回环、链路本地、CGNAT、未指定、组播等 IP 字面量（IPv4、IPv6 及 IPv4 映射地址；嵌入 IPv4 的隧道地址 6to4 `2002::/16`、其中继 `192.88.99.0/24`、Teredo `2001::/32`、NAT64 `64:ff9b::/96` 一律拒绝）。`dev` 环境额外允许 `http://localhost`、`http://127.0.0.1`、`http://[::1]`（任意端口）。不合规返回 400 `validation_failed`。投递时再次检查；Workers 的出站请求本身也到不了内网 |
| 残余风险 | 只检查 URL 字面量：Workers 无法在请求前解析 DNS，解析到私有地址的域名（含 DNS rebinding）在这里拦不住。部署在 Cloudflare 上时，Workers 的出站子请求不会被路由到运营者的内网；自部署 workerd 没有这层出站限制，需要运营者在网络层（出站防火墙 / 代理）自行阻止 identity、api、consumer 访问内网。 |
| 签名密钥 | `whsec_` + 32 字节随机数的 base64，只在创建和轮换时返回一次。签名需要原文，所以以原文存在平台 D1（与平台其他元数据同一信任边界）。轮换后旧密钥继续并行签名 24 小时（签名头同时带两个签名） |
| 审计 | `webhook.create` / `webhook.update` / `webhook.delete` / `webhook.rotate_secret` / `webhook.test`；审计中不写密钥 |

**事件**（payload 的 zod schema 在 `packages/contracts/src/webhooks.ts`）：

所有事件的请求体都是 `{ "id": "msg_…", "type": "…", "timestamp": "ISO 8601", "product_id": "…", "env": "…", "data": { … } }`。只含该产品环境自己的数据：没有邮箱、姓名、IP，也没有用户在其他产品的信息。

| type | 何时发送 | 发给哪些环境 | `data` |
|---|---|---|---|
| `user.joined` | 用户第一次在某个产品环境完成授权（`product_env_users` 新增一行；与 membership 的写入在同一 batch） | 该环境 | `{ user_id, anonymous, first_seen_at }` |
| `user.upgraded` | 匿名（游客）账号绑定了第一个凭据（ID 不变，§19.7） | 用户登录过的全部产品环境 | `{ user_id, provider }` |
| `user.deleted` | 删除流程完成：`scope = "account"` 为全局账号删除，`"product"` 为用户退出该产品后的数据清理 | 删除前用户登录过的产品环境（product 范围只限该产品） | `{ user_id, scope }` |
| `user.banned` | 封禁或更新封禁 | 用户登录过的全部产品环境 | `{ user_id, expires_at }`（不含原因） |
| `user.unbanned` | 解封或封禁到期 | 同上 | `{ user_id, reason: "admin" \| "expired" }` |
| `webhook.test` | 控制台“发送测试”，只发给该端点，不重试；不可订阅 | — | `{ webhook_id }` |

“用户登录过的产品环境”= `product_env_users` 中的记录（迁移时从已有 refresh token 回填）；用户退出产品或删除账号时这些记录随之删除。

**投递**：

| 项 | 规格 |
|---|---|
| Outbox | 事件写入 `webhook_messages`（每个产品环境一条，`id` 即 `webhook-id`），并为每个已启用且订阅了该类型的端点写一条 `webhook_deliveries`；与领域变更在同一个 D1 batch 中写入（删除完成、封禁、解封、首次进入；游客升级在引擎的账号创建钩子之后紧接着写入）。没有订阅端点时不写 |
| 首次尝试 | 产生事件的 Worker 用 `waitUntil` 立即投递；投递前以条件 UPDATE 认领（租约 5 分钟），cron 与 `waitUntil` 不会重复发送 |
| 请求 | `POST` JSON；头 `webhook-id`、`webhook-timestamp`（Unix 秒）、`webhook-signature`（`v1,<base64(HMAC-SHA256(key, "{id}.{timestamp}.{body}"))>`，多个签名以空格分隔），即 [Standard Webhooks](https://www.standardwebhooks.com/) 规范；`user-agent: z-cloudbase-webhooks/1`。超时 10 秒，不跟随重定向；只有 2xx 算成功 |
| 重试 | 失败后按 15 分钟 × 2^(n−1) 退避（上限 12 小时）：15 分钟、30 分钟、1 小时、2 小时、4 小时、8 小时、12 小时；共 **8** 次尝试（约 28 小时）后标记 `failed`，不再重试。重试由 consumer 已有的 15 分钟 cron 执行（不新增 cron 触发器），每次最多处理 100 条 |
| 停用 / 删除 | 停用端点时取消其未完成投递（`cancelled`）；删除端点同时删除其投递与记录 |
| 投递记录 | 每次尝试记一条：时间、状态码、耗时、错误摘要、响应摘要（2xx 为响应体前 256 字符；非 2xx 只记状态行如 `HTTP 500 Internal Server Error`，不读取响应体，避免把非预期目标的页面内容回显到控制台）；控制台显示最近 100 条。每个端点只保留最近 100 条尝试；消息与投递保留 30 天（daily cron 清理） |
| 校验 | `@z-cloudbase/server` 提供 `verifyWebhook({ secret, headers, body })`：常量时间比较，时间戳偏差超过 5 分钟拒绝 |

**数据模型**：`webhook_endpoints`（id `whe_…`、product_env_id、url、description、event_types JSON、enabled、secret、previous_secret、previous_secret_expires_at、created_by、时间戳）、`webhook_messages`（id `msg_…`、product_env_id、event_type、payload、created_at）、`webhook_deliveries`（message_id + endpoint_id 主键、status `pending`/`delivered`/`failed`/`cancelled`、attempts、next_attempt_at、last_attempt_at）、`webhook_attempts`（投递记录）。`product_env_users`（product_env_id + user_id 主键、first_seen_at）与代登录表 `impersonations` 见 21.5。

### 21.7 数据采集增强

- Web SDK：前端错误与未处理异常、Web Vitals、点击自动采集（均可配置，默认关闭）。
- Server SDK 上报事件；用户属性（产品级，不跨产品共享）。
- 设备与地域上下文尽量由服务端从请求派生，不信任客户端自报的身份字段。

**规格（2026-11-04）**

Web SDK 新增采集项，全部默认关闭，在 `createClient({ autocapture: {...} })` 中逐项开启：

| 选项 | 事件名 | 属性 | 隐私与限流 |
|---|---|---|---|
| `errors: true` | `js_error` | `message`（≤ 512 字符）、`type`（`error` / `unhandledrejection`）、`stack`（前 1000 字符）、`source`（脚本 URL，只保留 origin + path）、`line`、`col`、`path` | 与 `logs.captureError` 同一套脱敏：Bearer / JWT / 平台密钥替换为 `[REDACTED]`，消息与堆栈中所有 URL 去掉查询串和片段。同一页面加载内相同 `message + source + line` 只报一次；每次页面加载最多 10 条 |
| `webVitals: true` | `web_vital` | `name`（`LCP` / `INP` / `CLS` / `FCP` / `TTFB`）、`value`（毫秒；CLS 为无单位分数）、`rating`（`good` / `needs-improvement` / `poor`，阈值同 web.dev）、`path` | 用浏览器原生 `PerformanceObserver` 实现，不引入依赖；每个指标每次页面加载只报一次，在页面隐藏（`visibilitychange` → hidden / `pagehide`）时上报。INP 取本页最差一次交互的时长（近似值，不是 web.dev 的 p98 算法）。浏览器不支持的指标不上报 |
| `clicks: true` | `element_click` | `tag`、`selector`（`tag#id.class`，≤ 128 字符）、`text`（≤ 64 字符，只取链接 / 按钮 / 显式标注元素的可见文本）、`href`（链接的 origin + path）、`label`（`data-zcb-track` 的值） | 只采集交互元素（`a`、`button`、`[role=button]`、`input[type=button\|submit\|reset]`）和带 `data-zcb-track` 的元素；`clicks: 'attribute'` 时只采集带属性的元素。**从不读取输入框的值或文本**；祖先带 `data-zcb-no-track` 的元素不采集 |

- `page_view` 的 `path` 与 `referrer`（v3.1 起）默认去掉查询串：`path` = pathname（`#/` 开头的 hash 路由保留 hash，同样去掉其中的查询串），`referrer` = origin + pathname。
- **同意开关**：`analytics.optOut()` / `optIn()` / `hasOptedOut()`；初始值由 `analytics.consent: 'granted' | 'denied'`（默认 `granted`，与 v3.0 行为一致）决定，用户的选择按产品 + 环境保存在 `localStorage`（`zcb.{product}.{env}.consent`），优先于初始值。退出后：清空待发送队列、删除匿名 ID，`track` 与全部自动采集变成空操作，`setUserProperties` 以 `sdk_error` 拒绝。
- **用户属性**（产品环境级，不跨产品共享）：
  - Web：`analytics.setUserProperties(props)`（需已登录，用户由 access token 决定），`identify(props?)` 在附加 token 的同时可设置属性。Server：`analytics.setUserProperties(userId, props)`（服务密钥，需 `events:write`）。
  - HTTP：`POST /v1/events/user-properties` `{ properties, user_id? }`。publishable key 必须带用户 token，且不得带 `user_id`（400 `validation_failed`）；服务密钥必须带 `user_id`，该用户在本产品必须有 `active` membership，否则 403 `membership_required`。成功返回 `{ properties }`（合并后的完整属性）。
  - 语义：按 RFC 7396 合并（值为 `null` 删除该键）；值只允许标量；键 `^[A-Za-z0-9_]{1,64}$`；字符串值 ≤ 256 字符；合并后 ≤ 20 个键、JSON ≤ 2 KB，超出返回 413 `payload_too_large`（已有属性不变）。保存在 ingest D1 的 `user_properties`，以 `user_key`（§19.8 的 HMAC）为键，不保存原始 `user_id`。
  - 匿名访客**不提供**属性（数据最小化）；需要时作为事件属性上报。
- **Server SDK `analytics.track(name, props, { userId?, anonymousId?, eventId?, sessionId?, occurredAt? })`**（`trackServerEvent` 保留为同义方法）：
  - 服务密钥（`events:write`）可以在事件中携带 `user_id`，只有本产品 `active` membership 的用户才被接受；其余事件按条拒绝（`membership_required`），同批合法事件照常接受。`user_id` 只在 api Worker 内转为 `user_key`，不进入队列、归档或分析存储。
  - publishable key 的事件带 `user_id` 时按条拒绝（`user_id_not_allowed`）：浏览器只能通过自己的 token 归属用户。
  - `anonymous_id` 由产品后端自行转发（例如前端的匿名 ID），平台不做校验，也不与其他产品关联。
  - 批量与幂等：沿用 §19.6 的批次上限和 24 小时 `event_id` 去重；SDK 在排队时固定 `event_id`，重试不产生重复；调用方可传 `eventId`（UUID）实现端到端幂等。
- **服务端派生上下文**（不读取请求体，客户端也无法覆盖）：
  - publishable key 请求：从 `User-Agent` 解析 `browser`（chrome / edge / firefox / safari / opera / samsung / other / bot）、`os`（windows / macos / ios / android / linux / chromeos / other）、`device`（desktop / mobile / tablet / bot），不保存版本号与原始 UA；`country` 取 `request.cf.country`（ISO 3166-1 alpha-2，未知为空）。`source = client`。
  - 服务密钥请求：`source = server`，上述四个字段为空（后端请求的 UA / IP 不代表终端用户）。
  - `path` 维度取 `properties.path` 去掉查询串与片段后的前 256 字符。
- 队列消息（v3.1）：api 把同一请求的已接受事件打包，每条消息 ≤ 25 个事件且 ≤ 100 KB（Queues 单条上限 128 KB）；events 消费者 `max_batch_size = 10`，保证每次调用最多 250 个事件，正好是 Analytics Engine 每次调用写入数据点的上限。consumer 同时接受 v3.0 的单事件消息（升级期间队列里的存量）。

### 21.8 数据分析：漏斗、留存、属性分组与筛选、事件明细

- Analytics Engine 不支持按用户关联查询，漏斗和留存需要按用户的事件存储；存储设计必须考虑 Workers Free 套餐的 D1 容量（单库 500 MB）。
- 所有查询按产品与环境隔离，跨产品访问返回 403/404 且不泄露信息。

**规格（2026-11-04）**

存储（全部在 ingest D1，迁移 `database/ingest-migrations/0003`；不新增 Cloudflare 资源）：

| 表 | 主键 / 索引 | 内容 | 用途 |
|---|---|---|---|
| `event_rows`（替代 `events_substitute`，WITHOUT ROWID） | PK `(product_env_id, event_id)`；索引 `(product_env_id, occurred_at)` | 每个事件一行：名称、`user_key`、`anonymous_id`、`session_id`、时间、`source / browser / os / device / country / path`、自定义维度 `dim1–dim3`、属性 JSON（> 1 KB 时不保存，标记 `properties_truncated`，原文在归档中） | 事件明细；consumer 幂等；本地 / 测试兼作 Analytics Engine 替身（§19.10） |
| `actor_daily`（WITHOUT ROWID） | PK `(product_env_id, event_name, day, actor)`；索引 `(product_env_id, actor, day)` | 每个 actor 每天每个事件一行：`first_at`、`last_at`、`n`（次数）、当天首次发生时的维度 JSON | 漏斗、按事件的留存 |
| `actors`（WITHOUT ROWID） | PK `(product_env_id, actor)` | `first_day`、`last_day` | 首次出现队列（cohort） |
| `user_properties`（WITHOUT ROWID） | PK `(product_env_id, user_key)` | 属性 JSON、`updated_at` | §21.7 用户属性 |
| `analytics_settings` | PK `product_env_id` | `dimensions`（自定义维度键，≤ 3 个） | 维度映射 |

- `actor` = `user_key`（已登录事件），否则 `anon:` + `anonymous_id`；两者都没有的事件（例如不带用户的服务端事件）不进入 actor 表。**不做身份缝合**：同一设备登录前后是两个 actor（与 §4.5“匿名不自动关联”一致）。`day` = `occurred_at` 的 UTC 日序号。
- consumer 写入：同一产品环境的事件在一次调用内合并为 3 条 `json_each` 批量语句（一个事务），先按 `event_id` 查已存在的行，只为新事件写 Analytics Engine 与 actor 表；重投递不重复计数。
- **保留期**：部署变量 `ANALYTICS_RETENTION_DAYS`（默认 90，范围 1–90，api 与 consumer 都读取）。每日 cron（`0 3 * * *`）删除 `occurred_at` / `day` 早于保留期的 `event_rows`、`actor_daily`，以及 `last_day` 早于保留期的 `actors`；查询的时间范围被截到保留期内。`user_properties` 随用户删除或退出产品删除（见 §21.9）。
- **自定义维度**：`PUT /v1/admin/products/:id/analytics/settings?env=` `{ dimensions: ["plan", "level"] }`（`product:write`，审计 `analytics.settings_updated`）；键为事件属性名 `^[A-Za-z0-9_]{1,64}$`，最多 3 个，按顺序映射到 `dim1–dim3` 与 AE `blob12–blob14`。只影响此后写入的事件。`GET` 同路径返回 `{ dimensions, retention_days }`（`analytics:read`）。
- Analytics Engine 数据点（生产）：`index1 = product_env_id`；`blob1–5` 不变（product_id、env、event_name、user_key、anonymous_id）；`blob6 path`、`blob7 browser`、`blob8 os`、`blob9 device`、`blob10 country`、`blob11 source`、`blob12–14 dim1–3`；`double1 = 1`。

接口（均在 `/v1/admin/products/:id/analytics/*`，`env` 为必填查询参数，产品与环境只取自路径和查询参数并经现有 RBAC 中间件校验：`analytics:read`，导出为 `analytics:export`；时间参数 `from` / `to` 为 UTC 日期，`to` 不含，默认最近 7 天，范围截到保留期）：

| 端点 | 参数 | 返回 | 数据源 |
|---|---|---|---|
| `GET …/analytics/funnel` | `steps`（逗号分隔，2–5 个事件名，可重复）、`window`（转化窗口秒数，默认 86400，最大 30 天）、`filter`（`dim:value`，只作用于第一步）、`user_property`（`key:value`） | `{ steps: [{ event, actors, conversion }], window_s }`；`conversion` 相对第一步 | `actor_daily` |
| `GET …/analytics/retention` | `granularity`（`day` / `week`，默认 `day`）、`periods`（day ≤ 31，week ≤ 13，默认 7 / 4）、`start_event`（可选）、`return_event`（可选）、`user_property` | `{ cohorts: [{ cohort, size, retained: [n0, n1, …] }] }` | `actors` / `actor_daily` |
| `GET …/analytics/breakdown` | `by`（维度，必填）、`event`（可选）、`filter`（`dim:value`，最多 3 个，可重复）、`limit`（≤ 50，默认 20） | `{ rows: [{ value, events, users }], source }` | 生产：AE SQL；本地：`event_rows` |
| `GET …/analytics/events` | `event`、`actor`、`filter`、`before`（游标）、`limit`（≤ 100，默认 50） | `{ events: [...], next_before, user_properties? }`（按 `actor` 筛选时附带该 actor 的用户属性） | `event_rows` |
| `GET/PUT …/analytics/settings` | 见上 | | `analytics_settings` |
| `GET …/analytics/export` | 见 §21.9 | | R2 归档 |

- 维度（`by` / `filter`）：`event_name`、`path`、`browser`、`os`、`device`、`country`、`source`，以及已声明的 `prop:<key>`；未声明的键返回 400 `validation_failed`。
- 漏斗语义：第一步 = 每个 actor 在范围内第一次发生第一步的时间 t1（若有 `filter`，则只计当天首次发生时维度匹配的那天）；第 k 步 = 不早于 t(k-1)（与上一步是同一事件时须晚于 t(k-1)）、且在 t1 + window 之内的第 k 步最早发生时间。actor 表只保存每天的首次与末次时间，所以若某步在同一天先于 t(k-1) 发生过、之后又发生，用当天末次时间判断（可能低估转化，不会高估）。
- 留存语义：不带 `start_event` 时 cohort = actor 的首次出现日（`actors.first_day`，受保留期限制）；带 `start_event` 时 = 该事件在范围内第一次发生的那天。`retained[k]` = 第 k 个周期内发生过 `return_event`（缺省为任意事件）的 actor 数；周以 UTC 周一为起点。
- `users`（breakdown）= 不同 `user_key` 数（已登录用户）；Analytics Engine 对非 index 字段的去重计数在采样时是近似值（官方 sampling 文档），生产结果标 `source: analytics_engine`。
- **AE SQL 注入防护（v3.1 安全修复）**：AE SQL API 只接受 SQL 文本、没有参数绑定，官方也未说明字符串转义规则，因此不做转义：进入 SQL 的值只能是“纯字面量”（不含 `'`、`\`、控制字符）。`index1` 只来自服务端生成、经 `{product}.{env}` 格式校验的 id；事件名经 `EVENT_NAME_RE` 校验；breakdown 的 `filter` 值含上述字符时返回 400 `validation_failed`（本地 D1 替身同一规则，行为一致；漏斗、明细的 `filter` 只查 D1 并参数绑定，不受此限制）。breakdown 第二条查询（按值统计去重用户）的值来自终端用户上报的事件（`path`、`browser`、自定义维度等），不安全的值不放进查询，这些行的 `users` 返回 `null`（未知），控制台显示“–”。
- 跨产品：每个新端点都在读数据前做 `authorize`，A 的管理员查询 B 返回 403，不存在的产品返回 404；SQL 一律带 `product_env_id` 条件。

**容量与成本估算（Workers Free，访问时间 2026-11-04，上线前须基准验证）**

| 限额（官方） | 数值 | 对本设计的影响 |
|---|---|---|
| D1 单库容量 / 每日写入行 / 每日读取行 | 500 MB / 100,000 行 / 5,000,000 行；写入带索引列时索引也计行（D1 Limits、D1 Pricing） | 每个事件在其生命周期内约写 10–12 行（去重表插入与清理约 6，`event_rows` 插入与清理约 4，actor 表摊销约 1–2）⇒ **约 8,000–10,000 事件 / 天**是 Free 的上限，这是本设计最紧的约束 |
| D1 每次调用查询数 | 50（Free） | consumer 每个产品环境每次调用 3 条批量语句 + 1 条查重 |
| Queues 操作 | 10,000 次 / 天，每 64 KB 写、读、删各计一次（Queues Pricing） | 每条消息 3 次操作；v3.0 每事件一条消息 ⇒ 约 3,300 事件 / 天，v3.1 打包后按平均每批 10 个事件约 33,000 事件 / 天 |
| Analytics Engine | 每次调用 ≤ 250 个数据点；Free 每天 100,000 个数据点、10,000 次查询；保留 3 个月（AE Limits、AE Pricing） | consumer 每次调用 ≤ 250 个事件；控制台概览每次 4 条查询 |
| R2 | Free 每月 10 GB、Class A 100 万次、Class B 1,000 万次；PutObject / ListObjects 为 A，GetObject 为 B，DeleteObject 免费（R2 Pricing） | 归档每次 consumer 调用每个产品环境每天 1 次 PUT；持续有流量时单个环境最多约 17,280 次 / 天（5 秒一批），产品较多时应把 `max_batch_timeout` 调大 |
| Workers CPU | Free 每个 HTTP 请求 / Cron 10 ms（Workers Limits） | 导出与归档清理受限，见 §21.9 |

D1 存储估算：`event_rows` 约 400 B / 事件（含索引，属性平均 100 B），`actor_daily` 约 220 B / 行，同一 actor 同一天同一事件平均重复 3 次时约 75 B / 事件，合计约 475 B / 事件 ⇒ 500 MB 约容纳 100 万个保留期内的事件，90 天保留约 1.1 万事件 / 天，与写入上限同一量级。超过时运营者应调小 `ANALYTICS_RETENTION_DAYS` 或升级 Workers Paid（D1 单库 10 GB）。1K DAU × 每人每天 8 个事件约 8,000 事件 / 天，接近 Free 上限；10K / 100K DAU 需要 Paid。

来源（2026-11-04 访问）：https://developers.cloudflare.com/d1/platform/limits/ 、https://developers.cloudflare.com/d1/platform/pricing/ 、https://developers.cloudflare.com/queues/platform/limits/ 、https://developers.cloudflare.com/queues/platform/pricing/ 、https://developers.cloudflare.com/analytics/analytics-engine/limits/ 、https://developers.cloudflare.com/analytics/analytics-engine/pricing/ 、https://developers.cloudflare.com/analytics/analytics-engine/sampling/ 、https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/statements/ （不支持 JOIN / UNION，所以漏斗与留存不能放在 AE 上）、https://developers.cloudflare.com/r2/pricing/ 、https://developers.cloudflare.com/workers/platform/limits/ 。行大小是按列宽估算的，未实测。

### 21.9 原始事件存档与导出

- 原始事件按产品 / 环境 / 日期归档到 R2，控制台可导出 NDJSON / CSV。

**规格（2026-11-04）**

- 布局：`ARCHIVE` 桶 `events/v2/{yyyy}/{mm}/{dd}/{product_id}/{env}/{batch_id}.ndjson.gz`，日期为 `occurred_at` 的 UTC 日期；日期在前，过期清理按天整段删除。gzip 压缩的 NDJSON，每行一个事件：`event_id`、`event_name`、`occurred_at`、`received_at`、`user_key`、`anonymous_id`、`session_id`、`schema_version`、`properties`（完整）、`context`（`source / browser / os / device / country`）。`batch_id` 由消息 ID 决定，重投递覆盖同一对象；分组变化时同一事件可能出现在两个对象里，导出按 `event_id` 在每天内去重（归档为至少一次）。
- 只归档通过校验的事件（api 已校验，consumer 再次校验消息格式）；原始 `user_id` 不进入归档。
- v3.0 的旧对象（`events/{product}/{env}/…/*.ndjson`，未压缩）不参与导出、也不被自动清理；运营者升级后可手动删除这些前缀。
- **保留期**：部署变量 `ARCHIVE_RETENTION_DAYS`（默认 90，范围 1–3650）。每日 cron 删除 `events/v2/` 下早于保留期的日期分区（每次最多 7 个日期、每个日期最多 1,000 个对象；未删完的下次继续）。
- **导出**：`GET /v1/admin/products/:id/analytics/export?env=&from=&to=&format=ndjson|csv`，`analytics:export` 权限：owner、本产品 `product_admin`，`product_developer` 只能导出 dev / staging；operator 不能导出原始事件。范围按 UTC 日期，`to` 不含，最多 31 天且在归档保留期内；先列出对象，超过 2,000 个返回 413 `payload_too_large`（请缩小范围）。响应为流式下载（`content-disposition: attachment`），NDJSON 即归档行；CSV 列为 `event_id,event_name,occurred_at,received_at,user_key,anonymous_id,session_id,source,browser,os,device,country,properties`，`properties` 为 JSON 字符串，以 `= + - @` 开头的单元格前加 `'` 防止公式注入。每次导出写审计 `analytics.exported`（范围、格式、对象数）。Workers Free 每个请求只有 10 ms CPU，只适合导出小范围（约数 MB）；大范围导出需要 Workers Paid。
- **删除请求（§19.8）**：账号删除和退出产品在后台处理时，对涉及的每个产品环境计算该用户的 `user_key`，然后：
  1. 立即删除 `user_properties`、`actor_daily`、`actors`、`event_rows` 中该 `user_key` 的数据；
  2. 写入 `archive_suppressions(product_env_id, user_key, created_at)`；**此后每次导出都排除这些 `user_key` 的事件**（处理完成即生效）；
  3. 归档文件不改写：带该 `user_key` 的事件在所在日期分区到达 `ARCHIVE_RETENTION_DAYS` 时随分区删除；抑制记录保留到同一期限后由 cron 删除。默认 90 天，与 §19.8“冷静期 + 最长 90 天”一致；运营者调大归档保留期时，物理删除期限随之延长，必须在隐私政策中写明。
  4. Analytics Engine 中的数据点无法逐条删除，按 3 个月自然过期（§19.8 不变）。只带 `anonymous_id`、没有 `user_key` 的事件无法归属到账号，不在删除范围内。
- 不改写归档分区的原因：一次删除可能要读改写数千个 gzip 对象，Workers Free 的 10 ms CPU 无法在 cron 中完成，且每次改写都产生 Class A 操作；导出时排除 + 到期删除可以在限额内兑现删除承诺。

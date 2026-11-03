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
- 配置显示名、回调 URL 白名单、允许来源域名、隐私策略与数据保留策略。
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
- Claims：`iss`、`sub`（user_id）、`aud`（`urn:platform:{product_id}.{env}`；授予 `openid` 时引擎会额外附加 `{iss}/api/auth/oauth2/userinfo`，此外不允许出现其他成员）、`typ=at+jwt`、`exp`、`iat`、`jti`、`sid`（平台会话）、`pid`（product_id）、`env`、`anon`（boolean）、`scope`。不放邮箱等个人信息（需要时调用 `/userinfo`）。
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
| 403 | `forbidden` / `forbidden_product` / `product_disabled` / `membership_required` | 无权限、跨产品访问、产品已停用、受限产品无准入 |
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
- **Analytics 中的身份**：事件只写入 `user_key = HMAC(user_id, product_salt)`，不写原始 `user_id`。Analytics Engine 的数据无法逐条删除，依赖 90 天自然过期；R2 归档按分区重写或删除。PRD 承诺的删除完成时间 = 冷静期 + 最长 90 天，必须在隐私政策中如实说明。
- **导出**：生成 JSON（账户资料、membership、Storage 对象清单），写入私有 R2 路径，用一次性短期链接下载。
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
| 邮件 | Resend Adapter（D13） | `outbox` Adapter，邮件写入 D1 表供测试读取 | 远程部署 |
| R2 预签名 | S3 兼容预签名（`aws4fetch`） | Miniflare 没有 S3 端点，改用 `dev` 模式专用的 Worker 签名上传路由，只在本地 / 测试注册 | 远程部署 |
| Analytics Engine 查询 | AE SQL API | 实现同一 `AnalyticsQuery` 接口的 D1 替身 | 远程部署 |
| 认证限流 / 采集限流 / Turnstile | 认证：D1 计数器；采集：Cloudflare Rate Limiting 绑定（软限制）；Turnstile siteverify | 同一 D1 计数器（Miniflare）/ 本地绑定模拟 / Turnstile 官方测试 key | 远程部署 |

本地 POC 通过不等于 §14 POC-3 通过：凡是依赖替身的条目，都必须在验收矩阵中标记为“本地已验证 / 远程待验证”。

### 19.11 补充功能规格（2026-10-09）

> 产品负责人已于 2026-10-09 确认以下行为：Turnstile 的失败计数口径、事件名已登记但版本未登记时的处理、启用 TOTP 的用户登录产品时也要输入验证码、扩展名边界规则。

| 功能 | 规格 |
|---|---|
| Turnstile | v3.0：可选，部署方配置 site key 与 secret 后启用；未配置时不触发挑战，只有认证限流。启用时：同一账号或同一 IP 在 15 分钟内认证失败达到 3 次后（失败包括：密码错误的登录，按账号和 IP 计数；无效或过期的重置 token，只按 IP 计数。申请重置链接不计入，因为该接口对已注册和未注册的邮箱响应相同，以防枚举），登录、注册、找回密码、匿名升级到 Email 都必须附带有效的 Turnstile token。服务端通过验证接口 Adapter 校验：生产调用 siteverify；本地 / 测试使用替身，不访问网络。失败计数只保存账号哈希和 IP 哈希。 |
| 管理员 MFA | v3.0：TOTP 默认可选，管理员可在身份域账号页自行开启。已开启 TOTP 的管理员，控制台 client `platform_console` 的授权要求本次身份域会话通过了第二因素。部署开关 `REQUIRE_ADMIN_2FA=true` 时，未启用 TOTP 的管理员先被引导到身份域的 MFA 设置页（提供备用码）。产品 client 不受影响。丢失认证器时由运营者执行 `platform:reset-admin --disable-2fa`（§20.3）。 |
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
- `POST /setup/reset-admin` `{ email, password, disable_2fa? }`：只对平台团队成员生效；设置新密码、撤销全部会话和产品 token，可选移除 TOTP 与备用码，写审计 `auth.admin_password_reset`。普通用户走邮件找回。
- 管理员密码至少 12 位；脚本生成 24 位随机密码（去掉易混字符），只在终端显示一次。


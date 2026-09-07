# 政策知识库 · 写链路契约速查表

> 来源：policy-kb/server 全模块盘点（Explore 精读）+ capabilities 能力插件清单。
> 用途：P1–P3 自建实现依据。浏览闭环契约见 policy-api/src/server.js 头注释。

## 关键结论

- **没有 modification 模块**。原版"审批/纠错"= `policy-review`（审核中心）+ `policy-feedback`（详情页纠错/提建议，feedbackType 默认 `correction`）。
- **鉴权**：平台 `@NeedLogin` + `req.userContext.userId`。自建版用 auth.js 的 `requireUser`（401 `{authenticated:false, loginUrl:'/auth/login'}`）替代。
- **dashboard 双源降级**：优先本地 policy/policy_review 表（`source:'local'`, `needSync:false`）→ 失败兜底直连 Bitable（`source:'bitable'`, `needSync:true`）。policy-api 现为纯 Bitable 口径，语义一致。
- **hello 模块无路由**，整体丢弃。

## 模块接口清单

| 模块 | 接口 | 登录 | 要点 |
|---|---|---|---|
| dashboard | `GET /api/dashboard/stats` | 公开 | `IDashboardStats`：total/published/pendingReviews/expiringSoon/thisMonthNew/Updated/byCategory/byRegion/recentUpdates/expiringPolicies/needSync/source |
| feedback | `GET /api/feedback?policyId&status&page&pageSize` | 公开 | `IListResponse<IPolicyFeedback>` |
| feedback | `GET /api/feedback/:id` | 公开 | |
| feedback | `POST /api/feedback` | **需登录** | 详情页「纠错/建议」；body `IFeedbackInput`；userId 取自登录态 |
| feedback | `PATCH /api/feedback/:id` | **需登录** | body `{status?, reply?}`（审核人回复） |
| review | （审核中心）待审列表/审核动作/AI 元数据提取 | 需登录 | 审核动作推进状态机 |
| subscription | 订阅 CRUD + 订阅对象 | 需登录 | 推送走飞书消息能力插件 `policy_subscription_notification_push_1` |
| calendar | 日历事件 | 公开 | 事件来源：政策发布/生效日期聚合（原空态 `[]` 待 P2 替换） |
| crawl | `POST` 采集任务 | 需登录 | 能力：网页正文抓取 + AI 提取（见 capabilities） |
| version | `GET /api/versions/policy/:id` | 公开 | 版本历史（自建需本地库才能给真数据） |
| upload | 文档上传解析 | 需登录 | 能力：`policy_document_parser_1` / `policy_metadata_extract_1` |
| categories | 分类 | 公开 | policy-api 已实现 |
| settings | 设置（如 bitable-url） | - | policy-api 已实现 |
| sync | 同步 | - | Bitable ↔ 本地库（自建如需本地库用它） |
| permissions | 权限 | - | **SPA 不请求**，无需实现 |
| view | SPA catch-all | 公开 | policy-api 已用 sendShell 实现 |

## 状态机（review/feedback 待审）

- 待定：pending → approved / rejected（P2 以原版 policy-review service 实际值为准，实现前需精读该模块）

## capabilities 能力插件（决定采集/提取/推送形态）

| 文件 | 输入 → 输出 |
|---|---|
| `policy_webpage_content_crawl_1.json` | URL → 网页正文（crawl 用） |
| `policy_source_structured_extract_1.json` | 采集源 → 结构化（source 治理） |
| `policy_metadata_extract_2.json` | 正文 → AI 元数据（review ai-extract） |
| `policy_region_keyword_search_1.json` | 关键词/地区 → 匹配（crawl compare 流式） |
| `policy_document_parser_1.json` | 文档 → 解析文本（upload） |
| `policy_subscription_notification_push_1.json` | 订阅命中 → 飞书消息推送 |
| `policy-bitable-source.json` | Bitable appToken/tableId/fieldMapping 兜底配置 |

## 自建版落点（feishu-webapp）

- **身份**：policy-api/src/auth.js（OAuth 降级 + MOCK_LOGIN + requireUser）—— P1 ✅
- **应用态存储**：src/db.js（JSON 落盘 data/db.json：feedback/review 申请、订阅偏好、日历事件等）
- **AI 预审引擎**：src/llm.js（aiReviewModification / verifyIntake / remoteReview OpenAI 兼容）→ P3 接入
- **采集**：policy-api 采集路由 → src/llm.js aiExtractFromText → 待审池 → 审核通过 → Bitable OpenAPI create/update 回写
- **写回通道**：src/bitable.js 增加 createRecord/updateRecord（当前仅读）

# 政策知识库项目 · 交接文档

> 生成时间：2026-09-07 14:08
> 仓库：https://github.com/EXtreTricky/zhengcezhishiku（公开）
> 本地路径：`C:\Users\29388\WorkBuddy\2026-09-03-09-06-43\feishu-webapp`

---

## 一、系统概述

政策知识库 = **爬虫 + 质量闸门 + 审批台 + 飞书Bitable存储**

```
搜索引擎（Bing×10路）→ crawler.js → quality-gate.js（过滤）→ crawlQueue（待确认池）
                                                         ↓
                                              审批台 /admin/ 人工确认后写入 Bitable
                                                         ↓
                                              正式库（578条政策，10个分类）
```

---

## 二、当前运行状态

| 项目 | 状态 |
|------|------|
| 服务地址 | http://localhost:4201/ |
| 审批台 | http://localhost:4201/admin/ |
| 健康检查 | http://localhost:4201/api/health |
| 爬虫统计 | http://localhost:4201/api/crawl/stats |
| 服务运行时长 | ~22小时（自9/7启动） |
| 政策总数（Bitable） | 578条 |
| 待审批队列 | 150条 |
| 巡检任务 | 142/260 完成（55%） |
| 定时巡检 | 每6小时，下次 2026-09-08 08:00 |

---

## 三、关键文件说明

### 后端（Node.js Express）

| 文件 | 用途 |
|------|------|
| `policy-api/src/server.js` | 主入口，路由注册，中间件 |
| `policy-api/src/auth.js` | 飞书OAuth认证 + MOCK登录 |
| `policy-api/src/crawler.js` | 核心爬虫：搜索→解析→提取 |
| `policy-api/src/crawl-api.js` | 巡检API：matrix-run, crawled-pending, confirm |
| `policy-api/src/quality-gate.js` | 质量闸门：域名白/黑名单，标题检测 |
| `policy-api/src/cron.js` | 定时任务：每6小时触发本地巡检 |
| `policy-api/src/db.js` | 本地SQLite-like JSON数据库 |
| `policy-api/src/write-api.js` | 写入Bitable的API |

### 前端

| 文件 | 用途 |
|------|------|
| `policy-api/public/admin/index.html` | 审批台主页面 |
| `policy-api/public/admin/admin.js` | 审批台逻辑（筛选/排序/入库） |
| `policy-api/public/admin/admin.css` | 审批台样式 |
| `policy-api/public/app/` | 用户端政策浏览页 |

### 脚本

| 文件 | 用途 |
|------|------|
| `scripts/sweep-crawl.js` | 矩阵巡检主程序（260组合） |
| `scripts/enum-sweep.js` | 省级栏目枚举通道 |
| `scripts/clean-noise.js` | 回扫清理脏数据 |
| `scripts/probe-bitable.js` | Bitable连通性测试 |

### 配置

| 文件 | 用途 |
|------|------|
| `.env` | 环境变量（密钥！不提交Git） |
| `.env.example` | 配置模板 |
| `.gitignore` | Git排除规则 |

---

## 四、启动方式

### 方式一：直接启动（推荐开发调试）

```bash
cd C:\Users\29388\WorkBuddy\2026-09-03-09-06-43\feishu-webapp
MOCK_LOGIN=true NODE_ENV=development PORT=4201 CRON_ENABLED=true CRON_INTERVAL_HOURS=6 node policy-api/src/server.js
```

### 方式二：双击启动脚本

```
C:\Users\29388\WorkBuddy\start_policy_service.bat
```

### 方式三：看门狗（崩溃自动重启）

```
C:\Users\29388\WorkBuddy\watchdog.bat
```

### 方式四：Windows计划任务（开机自启）

```powershell
schtasks /run /tn PolicyKbCrawler
schtasks /query /tn PolicyKbCrawler /fo list
```

---

## 五、Git 状态

```
当前分支：main
本地领先远程：2 commits
待推送：
  - ea0334e chore: add nul to gitignore
  - a46fc9f fix: 修复分类字段为空导致前端筛选失效的 bug

手动推送命令（网络恢复后执行）：
  cd C:\Users\29388\WorkBuddy\2026-09-03-09-06-43\feishu-webapp
  git push origin main
```

---

## 六、数据说明

### 本地数据库
- 位置：`data/db.json`（已排除Git提交）
- 备份：`data/db.backup-*.json`
- 包含：crawlQueue（待确认池）、crawlTasks（巡检进度）

### 飞书 Bitable
- 数据来源：10个专题表（最低工资、年金、公积金等）
- 总记录：578条
- 分类覆盖：
  - 最低工资：554条
  - 高温津贴：3条
  - 病假工资：3条
  - 其他：18条

---

## 七、运维命令速查

```bash
# 检查服务是否运行
curl http://localhost:4201/api/health

# 查看爬虫统计
curl http://localhost:4201/api/crawl/stats

# 手动触发巡检
curl -X POST http://localhost:4201/api/cron/local-run

# 杀旧进程（端口冲突时）
powershell "Get-NetTCPConnection -LocalPort 4201 | Stop-Process"

# 查看日志
type C:\Users\29388\WorkBuddy\start_service.log
type C:\Users\29388\WorkBuddy\watchdog.log
```

---

## 八、已知限制 & 待办

### 已知限制
1. **百度搜索**：触发验证码时自动跳过（302检测），依赖Bing+gov.cn API
2. **未注册省份**：河北/山西/吉林等13省无枚举源，仅靠搜索通道（命中率低）
3. **GitHub推送**：当前网络阻断，2个commit待推送
4. **计划任务**：PolicyKbCrawler 下次运行时间为 N/A（需重新创建或手动触发）

### 建议后续优化
- [ ] 补充13省枚举源配置（省级人社厅网站列表）
- [ ] 配置 FEISHU_CRAWL_APP_TOKEN 启用飞书汇总模式
- [ ] 将 watchdog.bat 加入开机自启动（替代计划任务）
- [ ] 网络恢复后执行 `git push origin main`

---

## 九、密钥安全

以下文件包含敏感信息，**不要提交到Git**：

| 文件 | 包含内容 |
|------|----------|
| `.env` | FEISHU_APP_SECRET, SESSION_SECRET, LLM_API_KEY |
| `data/db.json` | 爬虫状态数据 |
| `cookiejar.txt` | 登录态Cookie |

验证密钥是否泄露：
```bash
cd C:\Users\29388\WorkBuddy\2026-09-03-09-06-43\feishu-webapp
git grep "SrjUsINs" $(git rev-list --all)
git grep "0ae642b0" $(git rev-list --all)
```
（应无输出）

---

## 十、快速访问

- 审批台：http://localhost:4201/admin/
- 用户端：http://localhost:4201/
- 健康检查：http://localhost:4201/api/health
- GitHub仓库：https://github.com/EXtreTricky/zhengcezhishiku

# 飞书自建网站应用 · 最小骨架

**架构定位**：飞书只做「工作台图标 + 单点登录」，业务代码、数据库、外部 API 调用全部跑在你自己的服务器上，出网不受飞书任何限制。

```
用户 → 飞书工作台点应用图标 → 浏览器打开 https://your.domain.com
                                    ↓ 未登录
                         302 → open.feishu.cn/authen/v1/authorize
                                    ↓ 已登录飞书则静默通过
                         302 回 → /auth/callback?code=xxx&state=xxx
                                    ↓ 服务端用 code 换 user_access_token
                         写加密 Cookie → 进入业务页面
```

---

## 一、飞书开发者后台配置清单

打开 <https://open.feishu.cn/app> → 创建**企业自建应用**。

| 步骤 | 位置 | 填什么 |
| --- | --- | --- |
| 1 | 凭证与基础信息 | 记下 **App ID**(`cli_xxx`) 和 **App Secret** |
| 2 | 添加应用能力 → **网页应用** | PC 端主页 / 移动端主页都填 `https://your.domain.com` |
| 3 | 安全设置 → **重定向 URL** | 加 `https://your.domain.com/auth/callback` |
| 4 | 安全设置 → **安全域名** | 加 `your.domain.com` |
| 5 | 权限管理 | 仅免登可不开；要手机号/邮箱需开 `contact:user.phone:readonly` 等，并和 `.env` 的 `FEISHU_SCOPE` 对齐 |
| 6 | 版本管理与发布 | 创建版本 → 申请发布 → 管理员审批通过 |

**只填主页而不填授权地址，是正确的做法**：主页填自己的域名，由后端判断 Cookie 决定是否跳授权。这样用户二次访问无需重复跳飞书。

### 常见报错

- **「请求非法，请联系应用开发者」** → 重定向 URL 没配，或配的和 `FEISHU_REDIRECT_URI` 不完全一致（协议、路径、结尾斜杠都要对得上）。
- **4401 该应用暂不可用** → 应用没发布 / 没通过审批 / 当前用户不在应用可用范围里。
- **授权页报 scope 错误** → 权限管理里没开通对应权限。
- **`code` 换了两次** → code 只能用一次，5 分钟过期，别在日志里重复回放。

---

## 二、本地跑起来

```bash
cp .env.example .env
# 填入 App ID / App Secret / 域名 / SESSION_SECRET
openssl rand -hex 32        # 生成 SESSION_SECRET

npm install
npm run dev                 # http://localhost:3000
```

### 不想等飞书应用审批？先看界面

两种方式，都不需要飞书配置：

**1）双击打开** `public/index.html`

`file://` 协议下页面会自动进入预览模式，用模拟用户「张伟」渲染登录后的完整界面，出网自检、受保护接口都返回模拟数据。也可以加参数强制预览：`public/index.html?mock=1`。

**2）起本地服务看完整交互流程**

```bash
MOCK_LOGIN=true NODE_ENV=development npm run dev
```

打开 <http://localhost:3000/auth/login>，会绕过飞书直接以模拟身份登录，Cookie、鉴权中间件、受保护接口走的全是真实代码路径——改完业务代码立刻能看到效果。等飞书应用审批通过，去掉 `MOCK_LOGIN` 就切换成真实免登。

> `MOCK_LOGIN` 只应出现在本机。它绕过了整个登录流程，线上开启等于任何人都能进。

本地调试飞书回调需要公网 HTTPS 地址，用内网穿透最快：

```bash
# 任选其一
npx localtunnel --port 3000 --subdomain myapp
cloudflared tunnel --url http://localhost:3000
```

拿到 `https://xxx.loca.lt` 后，把它填进飞书后台的重定向 URL，并设 `FEISHU_REDIRECT_URI=https://xxx.loca.lt/auth/callback`、`NODE_ENV=development`（否则 Secure Cookie 在 http 下不会下发）。

---

## 三、部署选型（重点）

### ⚠️ 先说 SCF 云函数的问题

你给的是 SCF 控制台，但这个场景**不推荐** SCF：

1. **出网 IP 是随机的。** SCF 默认走平台公共网关，出口 IP 不固定。如果业务要调「需要把你 IP 加白名单」的第三方接口（很多企业 API、银行、政务接口都这样），你就必须开「固定公网出口 IP」——而它是**同账号同地域所有函数共用一个随机 EIP**，不能自选、不能按函数隔离，一个地域最多 5 个。这恰恰和你要的「出网完全自由」矛盾。
2. **托管网站要额外挂 API 网关或用 Web 函数**，配置链路比直接开台服务器长得多。
3. **冷启动 + 无状态**：首次访问要等，WebSocket / 长连接 / 本地磁盘全部不可用。
4. **静态资源托管麻烦**，得配 API 网关或再接 COS。

**结论：只要有固定出口 IP 的需求，SCF 就是最差的选项。**

### 推荐顺序

| 方案 | 适合场景 | 出口 IP | 参考成本 |
| --- | --- | --- | --- |
| **轻量应用服务器 Lighthouse** ⭐ | 绝大多数自建网站应用 | 固定，可绑弹性公网 IP | 几十元/月 |
| CVM 云服务器 | 需要更高配、要进 VPC 打通内网 | 固定 | 百元级/月 |
| Docker + 任意主机 | 已有服务器 | 跟随主机 | 0 |
| CloudBase 云开发 | 想省运维，静态托管+云函数一体 | 不固定 | 按量 |
| SCF 云函数 | 纯 API、低频、无白名单需求 | 默认随机，需额外开固定 | 极低 |

### 方案 A：轻量应用服务器 / CVM（推荐）

```bash
# 1. 装 Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx

# 2. 拉代码、装依赖、配环境变量
git clone <你的仓库> /opt/feishu-webapp && cd /opt/feishu-webapp
npm install --omit=dev
cp .env.example .env && vim .env

# 3. 用 systemd 托管
sudo tee /etc/systemd/system/feishu-webapp.service >/dev/null <<'EOF'
[Unit]
Description=Feishu Web App
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/feishu-webapp
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node src/server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now feishu-webapp

# 4. 签发证书并反代
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain.com
```

Nginx 反代配置见 `nginx.example.conf`。

### 方案 B：Docker

```bash
docker build -t feishu-webapp .
docker run -d --name feishu-webapp --restart=always \
  -p 3000:3000 --env-file .env feishu-webapp
```

### 方案 C：SCF Web 函数（能用，但不推荐）

1. 控制台新建函数 → 类型选 **Web 函数** → 运行时 Node.js 18/20。
2. 上传整个目录（含 `node_modules`）。
3. 增加无扩展名启动文件 `scf_bootstrap` 并给执行权限：

   ```bash
   #!/bin/bash
   export PORT=9000
   export NODE_ENV=production
   /var/lang/node18/bin/node deploy/sls.js
   ```

   Node 路径以控制台显示的运行时尚本为准（`node16`/`node18`/`node20`）。
4. 函数配置 → 环境变量填 `.env` 里的各项。
5. 如果需要固定出口 IP：函数配置 → 网络 → 勾选「公网访问」+「固定公网出口 IP」。注意这个 EIP 是**同账号同地域共享**的，换 IP 要先把该地域所有函数的这个开关关掉再重开。
6. 自定义域名：函数配置 → 触发器 → 创建 API 网关触发器 / 绑定自定义域名并配置 HTTPS 证书。飞书回调必须是 HTTPS。

---

## 四、业务代码写在哪

- 前端：`public/`
- 受保护接口：`src/server.js` 里照着 `/api/hello` 加路由，用 `req.user` 拿身份
- 需要以用户身份调飞书 OpenAPI：`req.user.user_access_token`，直接 `Authorization: Bearer <token>` 请求 `open.feishu.cn`
- 需要以应用身份调（比如发消息、读写多维表格）：`feishu.getTenantAccessToken()`，已封装好
- 需要连数据库：直接连，走内网或公网都行，跟普通 Web 后端没区别

`user_access_token` 有效期 2 小时。若要长期会话，授权时 `FEISHU_SCOPE` 加上 `offline_access` 拿到 `refresh_token` 后用 `feishu.refreshToken()` 续期；本骨架把 refresh_token 一并存在加密 Cookie 里，续期逻辑留给你按业务接。

---

## 五、安全注意事项

- 会话 Cookie 用 AES-256-GCM 加密后写 HttpOnly，`SESSION_SECRET` 泄露等于会话可伪造，**不要进 Git**。
- 生产环境 `NODE_ENV` 必须为 `production`，否则 Cookie 不带 `Secure`。
- 回调里做了 `state` 校验防 CSRF，别删。
- 如果业务要判断「这个用户能不能用」，在 `/auth/callback` 里加白名单校验（open_id / 手机号 / 邮箱），别只靠飞书的可用范围。

---

## 六、补充注意事项（易踩坑）

### 6.1 应用能力必须选对

飞书后台 → 应用能力 → 添加 → 选 **「网页应用」**（不是「网站应用」或「小程序」）。三个是不同的东西：

- **网页应用**：浏览器打开你的域名，飞书只做 SSO → 就是我们要的
- **网站应用**：嵌入飞书 Web 端侧边栏，有 SDK 依赖
- **小程序**：飞书客户端内运行，完全不同的技术栈

### 6.2 可用范围必须设置

飞书后台 → 应用发布 → **可用范围**：必须添加用户或部门，否则 4401「该应用暂不可用」。即使是测试阶段，也要把自己加进去。

### 6.3 长期会话必须加 offline_access

默认授权不会下发 `refresh_token`。要实现"登录一次保持 7 天"，飞书后台 → 权限管理 → 搜索并开通 **`offline_access`**，同时 `.env` 的 `FEISHU_SCOPE` 也要包含它：

```
FEISHU_SCOPE=offline_access
```

### 6.4 user_access_token vs tenant_access_token

| | user_access_token | tenant_access_token |
|---|---|---|
| 获取方式 | OAuth 免登流程（已有） | `feishu.getTenantAccessToken()` |
| 代表谁 | 当前登录用户 | 应用自身 |
| 适用场景 | 读用户信息、以用户身份操作 | 发消息、读写多维表格、群管理 |
| IP 白名单 | 不需要 | 需要在后台配置服务器出口 IP |
| 有效期 | 2 小时（refresh_token 可续） | 2 小时（每次重新获取） |

如果业务要调用飞书 OpenAPI（如多维表格），需要用 **tenant_access_token**，此时必须在飞书后台 → 安全设置 → **IP 白名单** 中加入服务器的出口 IP。

### 6.5 首次发布流程

应用创建后默认是「未发布」状态，即使配好了所有东西也用不了：

1. 版本管理与发布 → **创建版本**
2. 填写版本号和更新说明 → **保存**
3. 点 **申请发布** → 等管理员在飞书管理后台审批通过
4. 审批通过后，应用才会出现在工作台

### 6.6 飞书客户端内打开的差异

用户从飞书客户端点应用图标打开时，浏览器已经登录了飞书，授权页会**静默通过**（不弹扫码），体验最好。但如果用户在未登录飞书的浏览器里直接访问你的域名，则需要手动扫码登录。

### 6.7 redirect_uri 必须精确匹配

飞书后台重定向 URL 和 `.env` 的 `FEISHU_REDIRECT_URI` 必须**逐字符一致**（包括 `https://`、路径末尾是否有 `/`）。不一致会报「请求非法，请联系应用开发者」。

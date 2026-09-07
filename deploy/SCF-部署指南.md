# 腾讯云 SCF 部署指南

## 前置条件
1. 腾讯云账号已开通云函数 SCF
2. 已注册域名（~10元/年）并完成备案（如用国内节点）
3. 飞书自建应用已创建（拿到 App ID 与 App Secret）

## 步骤

### 1. 上传代码到 SCF
- 登录腾讯云控制台 → 云函数 SCF → 新建函数
- 选择 **Web 函数** → 运行环境 **Node.js 18**
- 上传整个 feishu-webapp 目录（含 node_modules）
- 启动文件：`deploy/sls.js`
- 超时时间：60秒
- 内存：256MB

### 2. 配置环境变量
在函数配置 → 环境变量中添加：
```
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=<飞书开放平台 → 凭证与基础信息 → App Secret>
FEISHU_REDIRECT_URI=https://你的域名/auth/callback
SESSION_SECRET=openssl rand -hex 32 生成
SESSION_TTL=604800
NODE_ENV=production
# 前端随代码包自托管（policy-api/public），无需 SPA_DIR
```

### 3. 配置自定义域名
- SCF 控制台 → 触发器 → 自定义域名
- 绑定你的域名
- 上传 SSL 证书（Let's Encrypt 免费）
- 路径映射：`/` → 函数

### 4. 飞书后台配置
- 安全设置 → 重定向 URL：`https://你的域名/auth/callback`
- 权限管理 → 开通 `bitable:app`
- 多维表格 → 添加文档应用 → 授予可编辑
- 版本管理 → 创建版本 → 发布

### 5. 验证
```bash
curl https://你的域名/healthz
# 应返回 {"ok":true}
```

浏览器访问 → 跳转飞书登录 → 登录后看到政策列表

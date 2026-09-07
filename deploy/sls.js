'use strict';

/**
 * 腾讯云 SCF「Web 函数」适配入口
 * SCF Web 函数要求监听 0.0.0.0:9000
 * 启动方式见 scf_bootstrap
 */

process.env.PORT = process.env.PORT || '9000';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// 统一网关入口（SSO + 只读 + 写链路 + 自建前端：总览首页 / 与审批台 /admin/ 随包托管）
require('../policy-api/src/server');

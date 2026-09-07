// ============================================================
// pm2 进程守护（不想用 systemd 时的备选）
//
//   npm i -g pm2
//   pm2 start deploy/ecosystem.config.js --env production
//   pm2 save && pm2 startup      # 开机自启（按输出的命令再执行一次）
//   pm2 logs policy-kb
// ============================================================
module.exports = {
  apps: [
    {
      name: 'policy-kb',
      script: 'policy-api/src/server.js',
      cwd: '/opt/policy-kb',
      instances: 1,
      exec_mode: 'fork',
      // 单进程内存占用不大，超过 512M 自动重启，防泄漏
      max_memory_restart: '512M',
      // 生产环境从 .env 读；pm2 的 env_ 优先级低于 .env 里已存在的值
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // 日志文件
      out_file: '/var/log/policy-kb/out.log',
      error_file: '/var/log/policy-kb/err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // 日志轮转（需 pm2 install pm2-logrotate）
      // pm2 set pm2-logrotate:max_size 20M
      // pm2 set pm2-logrotate:retain 14
    },
  ],
};

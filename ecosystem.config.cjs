/**
 * PM2 进程配置（云服务器直部署用）
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs park-ops
 *   pm2 save && pm2 startup    # 开机自启
 *
 * 注意：exec_mode 必须是 fork —— better-sqlite3 是单文件数据库，
 * 多进程（cluster）并发写会锁冲突，实例数固定为 1。
 */
module.exports = {
  apps: [
    {
      name: 'park-ops',
      script: 'server/app.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        DB_PATH: './server/data.db',
        JWT_SECRET: 'please-change-me-in-production'
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true
    }
  ]
}

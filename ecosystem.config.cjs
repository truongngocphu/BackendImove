const path = require('path');

module.exports = {
  apps: [
    {
      name: 'th79-imove-core',
      cwd: __dirname,
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 3000,
      exp_backoff_restart_delay: 100,
      max_memory_restart: '800M',
      kill_timeout: 15000,
      listen_timeout: 10000,
      min_uptime: '10s',
      max_restarts: 20,
      merge_logs: true,
      time: true,
      out_file: path.join(__dirname, 'logs', 'core-out.log'),
      error_file: path.join(__dirname, 'logs', 'core-error.log'),
      node_args: '--enable-source-maps',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

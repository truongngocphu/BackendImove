module.exports = {
  apps: [{
    name: 'th79-imove-core',
    script: 'src/server.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '800M',
    time: true,
    env_production: { NODE_ENV: 'production' },
  }],
};

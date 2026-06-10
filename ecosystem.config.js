module.exports = {
  apps: [
    {
      name: 'finassist',
      script: 'dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      exp_backoff_restart_delay: 100,
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};

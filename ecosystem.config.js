module.exports = {
  apps: [
    {
      name: 'ntt-service',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      // PM2 will automatically load the .env file in the same directory
      env: {
        NODE_ENV: 'production',
        PORT: 3003
        // Other env vars will be loaded from .env file
      },
      error_file: './logs/ntt-error.log',
      out_file: './logs/ntt-out.log',
      log_file: './logs/ntt-combined.log',
      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // This ensures the .env file is loaded
      node_args: '-r dotenv/config'
    }
  ]
};
module.exports = {
  apps: [{
    name: 'brz-ntt-bridge',
    script: './dist/server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3003
    },
    error_file: './logs/bridge-error.log',
    out_file: './logs/bridge-out.log',
    log_file: './logs/bridge-combined.log',
    time: true
  }]
};
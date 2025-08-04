const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '.env') });

module.exports = {
  apps: [{
    name: 'brz-ntt-bridge',
    script: './dist/server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      ...process.env,  // Include all env vars from .env file
      NODE_ENV: 'production',
      PORT: 3003
    },
    error_file: './logs/bridge-error.log',
    out_file: './logs/bridge-out.log',
    log_file: './logs/bridge-combined.log',
    time: true
  }]
};
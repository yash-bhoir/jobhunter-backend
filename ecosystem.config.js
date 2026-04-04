/**
 * PM2 Ecosystem Configuration — JobHunter
 *
 * Usage:
 *   pm2 start ecosystem.config.js --env production
 *   pm2 reload ecosystem.config.js --env production   ← zero-downtime reload
 *   pm2 stop  ecosystem.config.js
 *   pm2 delete ecosystem.config.js
 *
 * For 500K users:
 *   - 'max' instances = one per CPU core
 *   - Socket.IO uses Redis adapter so users can connect to any instance
 *   - Rate limiting uses Redis so counters are shared across instances
 *   - Only instance 0 runs cron schedulers (pm_id === '0')
 */

module.exports = {
  apps: [
    {
      // ── Main API server (clustered) ──────────────────────────────
      name:       'jobhunter-api',
      script:     'server.js',
      instances:  'max',         // uses all available CPU cores
      exec_mode:  'cluster',

      // Restart policy
      max_memory_restart: '500M',   // restart if RAM > 500 MB per worker
      restart_delay:      4000,
      max_restarts:       10,
      min_uptime:         '5s',

      // Graceful shutdown
      kill_timeout:  30000,          // give 30s to drain connections
      wait_ready:    true,
      listen_timeout: 10000,

      // Environment
      env: {
        NODE_ENV: 'development',
        PORT:     5000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT:     5000,
      },

      // Logs
      out_file:  './logs/api-out.log',
      error_file: './logs/api-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // Watch (dev only)
      watch:  false,
      ignore_watch: ['node_modules', 'logs', 'uploads'],
    },
  ],
};

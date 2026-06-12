// PM2 process manager config for the first-gen GeminiClaw service.
// Runs the compiled artifact (dist/index.js) so behaviour matches production.
// After changing source code: `pnpm build && pm2 restart geminiclaw`.
module.exports = {
  apps: [
    {
      name: "geminiclaw",
      script: "dist/index.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      // Port/host come from config.yaml (server.port: 18790). No PORT env
      // override here so the config file stays the single source of truth.
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      min_uptime: "10s",
      max_memory_restart: "1G",
      out_file: "./server.log",
      error_file: "./server.log",
      merge_logs: true,
      time: true,
    },
  ],
}

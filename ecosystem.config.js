// PM2 config for running suno-api natively on the homelab Mac (10.0.0.70).
//
// Native rather than Docker on purpose: this app drives a real Chromium via
// Playwright to clear Suno's hCaptcha. In a headless container that flow has no
// escape hatch unless TWOCAPTCHA_KEY is funded — MANUAL_CAPTCHA needs a visible
// window. See CLAUDE.md.
//
//   pm2 start ecosystem.config.js
//   pm2 save
//
// Register PM2's startup hook as the LOGGED-IN USER, not as a system daemon —
// a LaunchDaemon has no Aqua session, so the manual-captcha window would never
// appear:
//   pm2 startup   # then run the command it prints
module.exports = {
  apps: [
    {
      name: 'suno-api',
      cwd: __dirname,
      script: 'npm',
      args: 'run start -- -p 3060',
      env: {
        NODE_ENV: 'production',
        // Everything else (SUNO_COOKIE, SUNO_MODEL, MANUAL_CAPTCHA, ...) is read
        // from .env in cwd. Do NOT put the cookie here — this file is committed.
      },
      // Chromium sessions are the memory hog; restart before the Mac feels it.
      max_memory_restart: '2G',
      autorestart: true,
      // A crash-looping browser launch shouldn't hammer suno.com.
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      merge_logs: true,
      time: true
    }
  ]
};

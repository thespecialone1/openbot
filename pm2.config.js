module.exports = {
  apps: [
    {
      name: "kt-api",
      script: "server.js",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      env: { NODE_ENV: "production" },
    },
    {
      name: "kt-telegram",
      script: "bot.js",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 4000,   // wait for API to be up first
      env: { NODE_ENV: "production" },
    },
    {
      name: "kt-whatsapp",
      script: "whatsapp-bot.js",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 6000,   // starts last, after API is ready
      env: { NODE_ENV: "production" },
    },
  ],
};
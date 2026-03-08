module.exports = {
  apps: [
    {
      name: "kt-api",
      script: "server.js",
      watch: false,
      env: { NODE_ENV: "production" },
    },
    {
      name: "kt-telegram",
      script: "bot.js",
      watch: false,
      env: { NODE_ENV: "production" },
    },
    {
      name: "kt-whatsapp",
      script: "whatsapp-bot.js",
      watch: false,
      // Give WhatsApp time after API is up
      restart_delay: 3000,
      env: { NODE_ENV: "production" },
    },
  ],
};

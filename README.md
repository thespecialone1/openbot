# Khaleej Times News Bot

Scrapes breaking news and most popular articles from [khaleejtimes.com](https://www.khaleejtimes.com) and delivers them via **Telegram** and **WhatsApp**.

---

## Project Structure

```
openbot/
├── server.js          # Express REST API (scraper endpoints)
├── scraper.js         # Cheerio + Quintype API scraping logic
├── bot.js             # Telegram bot
├── whatsapp-bot.js    # WhatsApp bot (Baileys)
├── pm2.config.js      # PM2 process manager config
├── .env.example       # Environment variable template
└── .gitignore
```

---

## First-Time Setup on Ubuntu Server

### 1. Clone the repo
```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
```

### 2. Install Node.js (if not installed)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 3. Install PM2 globally
```bash
sudo npm install -g pm2
```

### 4. Install dependencies
```bash
npm install
```

### 5. Configure environment
```bash
cp .env.example .env
nano .env
```
Fill in:
- `BOT_TOKEN` — from Telegram @BotFather
- `CHANNEL_ID` — your Telegram channel (e.g. `@mychannel`)
- `API_BASE` — leave as `http://localhost:3000`

### 6. Link WhatsApp (one-time only)
```bash
node whatsapp-bot.js
```
Scan the QR code:
- Open WhatsApp on your phone
- Go to **Settings → Linked Devices → Link a Device**
- Scan the QR in your terminal

Once you see `✅ WhatsApp connected!`, press `Ctrl+C` to stop.  
The session is saved in `./wa-session/` — you won't need to scan again.

---

## Running Everything

### Start all services with one command
```bash
npm start
```
This launches 3 processes via PM2:
| Process | What it does |
|---|---|
| `kt-api` | REST API server on port 3000 |
| `kt-telegram` | Telegram bot + auto-broadcast |
| `kt-whatsapp` | WhatsApp command bot |

### Other commands
```bash
npm run stop      # Stop all services
npm run restart   # Restart all services
npm run logs      # Live logs from all processes
npm run status    # See if all 3 are online
```

### Enable auto-start on server reboot (run once)
```bash
pm2 save
pm2 startup
```
PM2 will print a command — copy and run it. After that, all services start automatically every time the server reboots. No manual intervention needed.

---

## Telegram Bot

Auto-broadcasts to your channel every 2 minutes. Also responds to commands:

| Command | Description |
|---|---|
| `/latest` | Top 5 most popular articles |
| `/breaking` | Current breaking news |
| `/status` | Bot health and uptime stats |

## WhatsApp Bot

Anyone with your number can send:

| Command | Description |
|---|---|
| `/breaking` | Breaking news with timestamps |
| `/news` | Top 5 most popular stories |

---

## Updating the Bot

When you push changes to GitHub, pull and restart on your server:

```bash
git pull
npm install      # only if package.json changed
npm run restart
```

---

## Logs & Monitoring

```bash
npm run status          # quick health check
pm2 logs kt-api         # API server logs
pm2 logs kt-telegram    # Telegram bot logs
pm2 logs kt-whatsapp    # WhatsApp bot logs
pm2 monit               # live dashboard
```
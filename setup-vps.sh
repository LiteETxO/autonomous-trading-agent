#!/bin/bash
set -e

echo "=== Trading Agent VPS Setup ==="

# System update
apt-get update -y && apt-get upgrade -y

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git

# PM2 (process manager — auto-restart on crash/reboot)
npm install -g pm2

# ngrok
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | tee /etc/apt/sources.list.d/ngrok.list
apt-get update -y && apt-get install -y ngrok

# Clone repo
cd /root
git clone https://github.com/LiteETxO/autonomous-trading-agent.git
cd autonomous-trading-agent
npm install

echo "=== Setup complete. Waiting for .env ==="

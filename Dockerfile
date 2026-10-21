FROM node:22-slim

# ffmpeg merges video+audio and makes MP3s. python3/pip is only here to get the latest yt-dlp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Sites change often. Rebuild the image regularly to pick up a fresh yt-dlp.
RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp yt-dlp-ejs

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000
USER node
EXPOSE 3000
CMD ["node", "server.js"]

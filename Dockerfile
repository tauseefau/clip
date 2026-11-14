FROM node:26-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js ./
COPY public ./public
COPY fonts ./fonts

ENV PORT=3000 \
    HOST=0.0.0.0 \
    NODE_ENV=production

RUN mkdir -p /app/data/media /app/data/brand/music /app/data/tmp
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "server.js"]

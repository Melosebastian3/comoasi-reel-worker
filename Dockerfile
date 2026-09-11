FROM node:20-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip fonts-dejavu-core \
    && pip3 install --break-system-packages edge-tts \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "start"]

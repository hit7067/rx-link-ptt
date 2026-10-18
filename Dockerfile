FROM node:20-bookworm-slim
WORKDIR /app

# Build the open-source AMBE+2 codec and a small streaming PCM->AMBE bridge.
RUN apt-get update && apt-get install -y --no-install-recommends git make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/MW0MWZ/OpenDMR.git /tmp/OpenDMR \
    && make -C /tmp/OpenDMR \
    && g++ -O2 -std=c++17 -I/tmp/OpenDMR /app/server/ambe-encoder.cpp /tmp/OpenDMR/libopendmr.a -lm -o /app/ambe-encoder \
    && rm -rf /tmp/OpenDMR

COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]

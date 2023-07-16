FROM node:lts-alpine

WORKDIR /usr/src/app

COPY package*.json pnpm-lock.yaml* .npmrc* ./

RUN npm install -g pnpm

RUN pnpm install --frozen-lockfile

COPY src/ ./src/

# Starten der Anwendung
CMD ["pnpm", "start"]
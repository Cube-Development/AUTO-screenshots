# node:sqlite (хранилище сессий) требует Node >= 22.13
FROM node:22-bookworm

WORKDIR /app

COPY package.json /app/package.json

RUN npm install
RUN npx playwright install --with-deps

COPY . /app

CMD ["npm", "run", "start"]

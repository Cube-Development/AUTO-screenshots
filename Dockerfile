FROM node:20-bookworm

WORKDIR /app

COPY package.json /app/package.json

RUN npm install
RUN npx playwright install --with-deps

COPY . /app

CMD ["npm", "run", "start"]

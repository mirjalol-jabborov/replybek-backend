FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY sql ./sql

RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
USER node
EXPOSE 3100
# The schema is idempotent, so it's applied on every start.
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]

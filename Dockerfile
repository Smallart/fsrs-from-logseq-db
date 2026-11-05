# --- builder ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runner ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/src ./src
COPY --from=builder /app/next.config.mjs ./
COPY --from=builder /app/tsconfig.json ./
# npm start = `npm run migrate && next start`, and migrate runs
# `tsx --env-file=.env ...`. The container has no .env file, which would make
# tsx exit with an error before the app starts. Create an empty one — real
# environment variables are injected by Docker (compose `environment`) at
# runtime, they are NOT baked into the image.
RUN : > /app/.env
EXPOSE 8790
CMD ["npm", "start"]

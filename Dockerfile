# syntax=docker/dockerfile:1
#
# Multi-stage build. Pass --build-arg APP=<api|job-manager|scraper> to pick
# which app this image runs.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY apps ./apps
COPY libs ./libs
ARG APP
RUN test -n "$APP" || (echo "APP build arg required" && exit 1) \
 && npm run build:${APP}

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ARG APP
ENV APP_NAME=${APP}
RUN chown -R node:node /app
USER node
CMD ["sh", "-c", "node dist/apps/${APP_NAME}/apps/${APP_NAME}/src/main"]

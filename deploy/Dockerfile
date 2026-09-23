# A self-hosted agent server.
#
# The build stage compiles the application; the runtime stage installs production dependencies only
# and runs as a non-root user. Adjust the entry point to your own server module: this one builds the
# repository's example.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY examples ./examples
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# The server listens on PORT, and reports readiness on /health.
ENV PORT=8080
EXPOSE 8080
USER node

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/examples/agent-server.js"]

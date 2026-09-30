# A self-hosted agent server. One image; ROLE decides whether a container is an API, a worker, or both.
#
#   docker build -t agent-server deploy/app
#   docker run -p 8080:8080 agent-server
#
# The app is plain ESM, so there is no build step: the image installs the published packages and runs.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && npm cache clean --force

COPY *.mjs ./

# The server listens on PORT, answers /health without credentials, and drains on SIGTERM.
ENV PORT=8080
EXPOSE 8080
# The node user, by number, so Kubernetes can verify runAsNonRoot.
USER 1000:1000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]

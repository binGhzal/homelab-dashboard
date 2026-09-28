# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
RUN npm install --global pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json vite.config.ts vitest.config.ts index.html ./
COPY server ./server
COPY shared ./shared
COPY src ./src
COPY public ./public
COPY tests ./tests
COPY config ./config
RUN pnpm test && pnpm build
RUN pnpm prune --prod

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
# Dependencies are installed in the build stage; the runtime needs only Node.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
LABEL org.opencontainers.image.title="Homelab Dashboard" \
      org.opencontainers.image.description="A personal app desktop with OpenID Connect and server-enforced access groups" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/binGhzal/homelab-dashboard"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node docs/licenses ./docs/licenses
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/main.js"]

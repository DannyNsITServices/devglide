# ── Stage 1: Install dependencies and build ──────────────────────────────────
FROM node:22-bookworm-slim AS builder

# Install native addon build dependencies (node-pty, better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .nvmrc ./
COPY src/apps/*/package.json ./src/apps/
COPY src/packages/*/package.json ./src/packages/

# Flatten app package.json paths (COPY above puts them flat, need proper structure)
RUN find src/apps -maxdepth 1 -name "package.json" -exec sh -c \
    'dir=$(basename $(dirname {})); mkdir -p src/apps/$dir && mv {} src/apps/$dir/' \; 2>/dev/null; \
    find src/packages -maxdepth 1 -name "package.json" -exec sh -c \
    'dir=$(basename $(dirname {})); mkdir -p src/packages/$dir && mv {} src/packages/$dir/' \; 2>/dev/null; \
    true

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the project
RUN pnpm build

# ── Stage 2: Production image ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS production

# Runtime dependencies for node-pty (needs libc, libutil)
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# Copy package manifests and install production dependencies only
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .nvmrc ./
COPY --from=builder /app/src/apps/*/package.json ./src/apps/
COPY --from=builder /app/src/packages/*/package.json ./src/packages/

RUN pnpm install --frozen-lockfile --prod

# Copy built output from builder
COPY --from=builder /app/src ./src
COPY --from=builder /app/bin ./bin

# Create devglide data directory
RUN mkdir -p /root/.devglide

# Default port
ENV PORT=7001
EXPOSE 7001

# Use tini for proper signal handling (PID 1 zombie reaping, SIGTERM forwarding)
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "src/server.ts"]

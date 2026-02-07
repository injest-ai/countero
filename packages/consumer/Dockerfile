# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package.json package-lock.json turbo.json ./
COPY packages/types/package.json packages/types/
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/provider-mongo/package.json packages/provider-mongo/
COPY packages/consumer/package.json packages/consumer/

RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY packages/types/ packages/types/
COPY packages/core/ packages/core/
COPY packages/sdk/ packages/sdk/
COPY packages/provider-mongo/ packages/provider-mongo/
COPY packages/consumer/ packages/consumer/

RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine

WORKDIR /app

RUN addgroup -g 1001 -S counterbridge && \
    adduser -S counterbridge -u 1001 -G counterbridge

# Copy package files and install production deps only
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/provider-mongo/package.json packages/provider-mongo/
COPY packages/consumer/package.json packages/consumer/

RUN npm ci --omit=dev

# Copy built output
COPY --from=builder /app/packages/types/dist/ packages/types/dist/
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/sdk/dist/ packages/sdk/dist/
COPY --from=builder /app/packages/provider-mongo/dist/ packages/provider-mongo/dist/
COPY --from=builder /app/packages/consumer/dist/ packages/consumer/dist/

USER counterbridge

CMD ["node", "packages/consumer/dist/index.js"]

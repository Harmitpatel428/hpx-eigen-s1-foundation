# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies for building
COPY package.json package-lock.json ./
COPY prisma ./prisma/
RUN npm ci

# Copy source code and build
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# Stage 2: Runner
FROM node:20-alpine

WORKDIR /app

# Copy package and dependencies (including generated Prisma client)
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules

# Copy built artifacts and Prisma schema
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

COPY start.sh ./
RUN chmod +x start.sh

# Expose port and run server
EXPOSE 3000
CMD ["./start.sh"]

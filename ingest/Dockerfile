FROM oven/bun:1.3.9
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --production
COPY tsconfig.json ./
COPY src ./src
CMD ["bun", "run", "src/server.ts"]

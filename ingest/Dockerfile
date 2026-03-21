FROM oven/bun:1.3.9
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY tsconfig.json ./
COPY src ./src
CMD ["bun", "run", "src/server.ts"]

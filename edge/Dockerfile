FROM oven/bun:1.3.9
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
  && bun -e "await import('@liamcottle/meshcore.js')"
COPY tsconfig.json ./
COPY src ./src
CMD ["bun", "run", "src/main.ts"]

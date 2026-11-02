FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
RUN mkdir -p /app/data && chown bun:bun /app/data
VOLUME /app/data
ENV PORT=3000
EXPOSE 3000
USER bun
CMD ["bun", "run", "src/index.ts"]

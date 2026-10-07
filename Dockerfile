FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown node:node /data

USER node
ENV HOME=/data

EXPOSE 8787

CMD ["node", "src/cli.js", "serve", "--host", "0.0.0.0", "--port", "8787"]

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY annotation ./annotation
RUN npm run build:annotate

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production ANNOTATION_HOST=0.0.0.0 ANNOTATION_PORT=3002 ANNOTATION_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force && mkdir /data && chown node:node /data
COPY --from=build --chown=node:node /app/annotation/dist ./annotation/dist
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "require('node:http').get({hostname:'127.0.0.1',port:3002,path:'/api/annotation/health',headers:{Host:new URL(process.env.ANNOTATION_ORIGIN).host}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "annotation/dist/runtime/server/index.js"]

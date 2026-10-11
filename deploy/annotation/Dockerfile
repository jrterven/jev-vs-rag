FROM node:24-bookworm-slim
ENV NODE_ENV=production ANNOTATION_HOST=0.0.0.0 ANNOTATION_PORT=3002 ANNOTATION_DATA_DIR=/data
WORKDIR /app
COPY runtime/package.json runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && mkdir /data && chown node:node /data && chmod 700 /data
COPY --chown=node:node annotation/dist ./annotation/dist
COPY --chown=node:node restore-stdin.mjs ./ops/restore-stdin.mjs
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "require('node:http').get({hostname:'127.0.0.1',port:3002,path:'/api/annotation/health',headers:{Host:new URL(process.env.ANNOTATION_ORIGIN).host}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "annotation/dist/runtime/server/index.js"]

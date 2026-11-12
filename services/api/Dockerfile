# 같이타 API 서버 이미지. 웹앱 파일을 같이 담아 한 주소에서 내보낸다.
# 빌드는 저장소 루트에서: docker build -f services/api/Dockerfile .
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY services/api/package.json services/api/package-lock.json services/api/
RUN cd services/api && npm ci --omit=dev && npm cache clean --force
COPY services/api/server.js services/api/schema.sql services/api/
COPY apps/web apps/web
USER node
EXPOSE 8787
CMD ["node", "services/api/server.js"]

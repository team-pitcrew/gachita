# 가치타 API 서버 이미지. 웹앱 파일을 같이 담아 한 주소에서 내보낸다.
# 빌드는 저장소 루트에서: docker build -f backend/api/Dockerfile .
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY backend/api/package.json backend/api/package-lock.json backend/api/
RUN cd backend/api && npm ci --omit=dev && npm cache clean --force
COPY backend/api/server.js backend/api/db.js backend/api/log.js backend/api/*.sql backend/api/
COPY backend/api/providers backend/api/providers
COPY frontend/web frontend/web
USER node
EXPOSE 8787
CMD ["node", "backend/api/server.js"]

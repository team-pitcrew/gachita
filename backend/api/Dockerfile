# 가치타 API 서버 이미지. 웹앱 파일을 같이 담아 한 주소에서 내보낸다.
# 빌드는 저장소 루트에서: docker build -f backend/api/Dockerfile .

# 폰 웹의 화자 값 모델·실행기(T170): 저장소에 넣지 않고 공식 릴리스에서 받아 값(sha256·npm sha512)을 확인한다.
# 바깥으로 나가는 것은 이 단계뿐이고, 값이 다르면 빌드가 멈춘다. 서버가 /models/…, /vendor/ort/…로 준다.
FROM node:22-alpine AS assets
WORKDIR /src
COPY backend/api/fetch-assets.mjs ./
RUN node fetch-assets.mjs /assets

FROM node:22-alpine
RUN apk add --no-cache ffmpeg font-noto-cjk
WORKDIR /app
ENV NODE_ENV=production
COPY backend/api/package.json backend/api/package-lock.json backend/api/
RUN cd backend/api && npm ci --omit=dev && npm cache clean --force
COPY backend/api/server.js backend/api/db.js backend/api/log.js backend/api/scenes.js backend/api/ride-links.js backend/api/profile-lifecycle.js backend/api/result-shares.js backend/api/short-*.js backend/api/*.sql backend/api/
COPY backend/api/todos.js backend/api/
COPY backend/api/trip-audio.js backend/api/
COPY backend/api/places.js backend/api/
COPY backend/api/rest-stops.js backend/api/rest-stops.json backend/api/
COPY backend/api/providers backend/api/providers
COPY backend/api/boarding-invites.js backend/api/
COPY backend/api/accounts.js backend/api/
COPY backend/api/profile-photos.js backend/api/
COPY backend/api/groups.js backend/api/
COPY frontend/web frontend/web
COPY --from=assets /assets backend/api/assets
USER node
EXPOSE 8787
CMD ["node", "backend/api/server.js"]

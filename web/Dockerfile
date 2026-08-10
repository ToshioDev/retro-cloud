FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM deps AS build
# Empty default → frontend auto-detects from window.location at runtime.
# Set VITE_SIGNALING_URL only for local dev (e.g. ws://localhost:8080/signaling).
ARG VITE_SIGNALING_URL=
ENV VITE_SIGNALING_URL=${VITE_SIGNALING_URL}
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN npm install -g serve
COPY --from=build /app/dist ./dist
EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "5173"]
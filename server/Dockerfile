FROM node:22-alpine AS build
WORKDIR /app/server
COPY package.json /app/package.json
COPY server/package*.json ./
COPY server/tsconfig.json ./
RUN npm ci
COPY server/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app/server
COPY package.json /app/package.json
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/server/dist ./dist
RUN mkdir -p /app/uploads /app/inbox
EXPOSE 3000
CMD ["npm", "start"]

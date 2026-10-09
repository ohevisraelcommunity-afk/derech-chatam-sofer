# Optional: run the app in Docker with Poppler installed (accurate Hebrew PDF
# reading). Only needed if the hosting platform doesn't already have pdftotext.
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "server.js"]

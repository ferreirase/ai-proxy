FROM node:20-alpine

WORKDIR /app

# Copia os arquivos necessários
COPY index.js .
COPY whitelist.json .

EXPOSE 3001

CMD ["node", "index.js"]

FROM node:20-alpine

WORKDIR /app
COPY package.json server.js client.html ./

# Hugging Face Spaces routes traffic to the port declared in README.md (app_port)
ENV PORT=7860
EXPOSE 7860

USER node
CMD ["node", "server.js"]

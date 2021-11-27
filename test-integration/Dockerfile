FROM node:slim

# Install dependencies
WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm install --no-optional && npm cache clean --force

# Install app
COPY *.js /app/

# Export app port and set entrypoint at startup
EXPOSE 3000
ENTRYPOINT ["node", "kafka_integration.js"]
CMD [""]

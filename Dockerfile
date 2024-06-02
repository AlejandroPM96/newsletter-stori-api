# Use an official Node.js runtime as a parent image
FROM node:21-slim

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . ./
COPY serviceAccountKey.json /usr/src/app/serviceAccountKey.json

# Expose the port the app runs on
EXPOSE 8080

# Run the application
CMD ["npm", "run", "start"]

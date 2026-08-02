# syntax=docker/dockerfile:1 
                                                                                                                                                                                                    
FROM node:lts-bookworm AS builder                                                                                       
WORKDIR /src                                                                                                            
COPY package*.json ./                                                                                                   
RUN npm install                                                                                                         
COPY . .                                                                                                               
RUN npm run build                                                                                                       
                                                                                                                    
FROM node:lts-bookworm                                                                                                  
WORKDIR /app                                                                                                            
COPY package*.json ./                                                                                                   
                                                                                                                    
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y libnss3 \                                       
    libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \                       
    libgbm1 libxkbcommon0 libasound2 libcups2 xvfb                                                                      
                                                                                                                    
# NOTE (fork): upstream baked SUNO_COOKIE into the image via a build ARG/ENV.
# That persists a rotating credential into image layers, so it leaks into any
# registry push and forces an image rebuild on every cookie rotation.
# The cookie is now supplied at RUNTIME only, via docker-compose `env_file`.
# Disable GPU acceleration, as with it suno-api won't work in a Docker environment
ENV BROWSER_DISABLE_GPU=true

RUN npm install --only=production                                                                                       
                                                                                                                    
# Install all supported browsers, else switching browsers requires an image rebuild                                     
RUN npx playwright install chromium                                                                                     
# RUN npx playwright install firefox                                                                                     
                                                                                                                    
COPY --from=builder /src/.next ./.next                                                                                  
EXPOSE 3000                                                                                                             
CMD ["npm", "run", "start"]
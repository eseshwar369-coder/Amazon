# Playwright/Chromium is preinstalled in this base image — required now that
# the scraper drives a real browser instead of making plain HTTP requests.
FROM apify/actor-node-playwright-chrome:20

# apify/actor-node-playwright-chrome images run as a non-root user by default;
# switch to root just for the install step so npm can write to node_modules.
USER root
COPY package*.json ./
RUN npm install --omit=dev --omit=optional

COPY . ./
USER myuser

CMD npm start --silent

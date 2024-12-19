# Start from the official Caddy image
FROM caddy:2-alpine

# Copy in our Caddy configuration
COPY Caddyfile /etc/caddy/Caddyfile

# Create the files directory
RUN mkdir -p /srv/files && \
  chown -R 1000:1000 /srv/files

# Only expose HTTP port
EXPOSE 80

# Start from the official nginx Alpine image
FROM nginx:alpine

# Copy in our nginx configuration
COPY nginx.conf /etc/nginx/nginx.conf

# Create the files directory and set ownership
RUN mkdir -p /srv/files && \
    chown -R nginx:nginx /srv/files && \
    # Create log directory
    mkdir -p /var/log/nginx && \
    # Ensure nginx can write to necessary directories
    chown -R nginx:nginx /var/log/nginx /var/cache/nginx /var/run

# Expose HTTP port
EXPOSE 80

# Run nginx in foreground
CMD ["nginx", "-g", "daemon off;"]

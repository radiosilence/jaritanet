FROM nginx:1.29-alpine

COPY nginx.conf /etc/nginx/nginx.conf

# Remove stock default.conf, create dirs, set ownership
RUN rm -f /etc/nginx/conf.d/default.conf && \
    mkdir -p /srv/files /var/log/nginx && \
    chown -R nginx:nginx /srv/files /var/log/nginx /var/cache/nginx /var/run

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

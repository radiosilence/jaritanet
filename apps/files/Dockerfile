FROM nginx:1.31.9-alpine

COPY nginx.conf /etc/nginx/nginx.conf

# The pid file and temp paths are under /tmp (see nginx.conf), so the image runs
# as any non-root uid without owning a directory.
RUN rm -f /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

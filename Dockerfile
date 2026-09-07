FROM node:22-alpine

RUN apk add --no-cache arp-scan libcap \
    && setcap cap_net_raw+ep "$(command -v arp-scan)" \
    && mkdir -p /app /data \
    && chown node:node /app /data

WORKDIR /app
COPY --chown=node:node *.mjs index.html ./

USER node
ENV IPAM_DATA_PATH=/data/ipam-state.json
EXPOSE 8787
CMD ["node", "run.mjs"]

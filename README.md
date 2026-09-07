# Homelab IPAM

Dependency-free Node service for retaining LAN scan results, with a concise web UI and manual scans. The scanner process is bounded by a configurable timeout; successful results are stored in `/data/ipam-state.json` in the container.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `IPAM_PORT` | `8787` | HTTP listening port |
| `IPAM_HOST` | `0.0.0.0` | HTTP listening address |
| `IPAM_DATA_PATH` | `/data/ipam-state.json` | Persistent state file |
| `IPAM_SCAN_COMMAND` | `arp-scan` | Scanner executable |
| `IPAM_SCAN_ARGS_JSON` | `[]` | JSON array of scanner arguments |
| `IPAM_SCAN_TIMEOUT_MS` | `30000` | Positive scan timeout in milliseconds |
| `UNIFI_BASE_URL` | empty | Optional UniFi API base URL for hostname enrichment |
| `UNIFI_API_KEY` | empty | Optional UniFi API key for hostname enrichment |
| `UNIFI_CLIENTS_PATH` | empty | Optional complete clients API path; otherwise the first UniFi site is used |
| `UNIFI_CA_CERT_PATH` | `/run/secrets/unifi-ca.pem` | Path to the UniFi CA certificate mounted into the container |

Configuration contains no credentials. Supply only deployment-specific scanner arguments, for example `IPAM_SCAN_ARGS_JSON='["--localnet"]'`.

## Container deployment

Build the image and create a named volume:

```sh
docker build -t homelab-ipam:latest ./ipam
docker volume create ipam-data
```

Run it on the host network so LAN discovery occurs from the Docker VM. The Node process remains the image's non-root `node` user; the scanner receives only the network capabilities it needs.

For UniFi enrichment, place `UNIFI_BASE_URL=https://unifi.local/proxy/network/integration/v1`, `UNIFI_API_KEY`, and `UNIFI_CA_CERT_PATH=/run/secrets/unifi-ca.pem` in a protected env file. Map `unifi.local` to the controller address when the certificate is issued to that hostname.

```sh
docker run -d \
  --name ipam \
  --restart unless-stopped \
  --network host \
  --add-host unifi.local:192.168.1.1 \
  --cap-drop ALL \
  --cap-add NET_RAW \
  --mount type=bind,src=/home/kallum/homelab-ipam/unifi-ca.pem,dst=/run/secrets/unifi-ca.pem,ro \
  --env 'IPAM_SCAN_ARGS_JSON=["--localnet"]' \
  --mount source=ipam-data,target=/data \
  homelab-ipam:latest
```

Open `http://DOCKER_VM_ADDRESS:8787/`. The named `ipam-data` volume preserves `/data/ipam-state.json` across container replacement. Adjust scanner arguments and the timeout for the target LAN; do not put credentials in the image or command line.

For systemd-managed deployment, copy `ipam.service.example` to `/etc/systemd/system/ipam.service`, review the image name and scanner arguments, then enable it with `systemctl enable --now ipam.service`.

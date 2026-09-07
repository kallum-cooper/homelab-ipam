# Homelab IPAM

Dependency-free Node service for retaining LAN scan results, with a concise web UI and manual scans. The scanner process is bounded by a configurable timeout; successful results are stored in `/data/ipam-state.json` in the container.

## Repository layout

```text
compose.yml        # easy deployment using the published image
compose.dev.yml    # local source-build override
Dockerfile         # builds the image
src/               # editable application source and tests
README.md
```

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

The public image is published at `ghcr.io/kallum-cooper/homelab-ipam`. The normal deployment only needs this repository's `compose.yml`, a protected `unifi.env`, and the UniFi CA certificate:

```sh
cp unifi.env.example unifi.env
# Edit unifi.env and set UNIFI_API_KEY.
chmod 600 unifi.env

# Save the UniFi CA certificate as unifi-ca.pem.
docker compose up -d
```

`compose.yml` runs the image on the host network so LAN discovery occurs from the Docker VM. The Node process remains the image's non-root `node` user; the scanner receives only the network capability it needs. The named `ipam-data` volume preserves `/data/ipam-state.json` across container replacement. Do not put credentials in the image or command line.

Open `http://DOCKER_VM_ADDRESS:8787/`.

### Development

The source remains available in this repository. To build and run local changes instead of pulling the published image:

```sh
docker compose -f compose.yml -f compose.dev.yml up -d --build
```

The development override keeps the same runtime configuration and persistent volume while replacing the image with a local build.

For systemd-managed deployment, copy `ipam.service.example` to `/etc/systemd/system/ipam.service`, review `WorkingDirectory`, then enable it with `systemctl enable --now ipam.service`.

# Annotation deployment

The deployment package contains only the compiled annotation frontend, Fastify server, and locked runtime dependencies. It excludes source documents, databases, model weights, provider credentials, and the retrieval demo.

Requirements: Docker Engine 28+, Docker Compose v2 with `up --wait`, `curl`, `tar`, and `sha256sum` or `shasum`. The default configuration binds the application to host loopback and uses an existing HTTPS reverse proxy.

## Build a release

```sh
npm ci
node deploy/annotation/package.mjs --name annotation-release-001
node --test deploy/annotation/tests/*.test.mjs
```

The package and checksum are written to `output/annotation-releases/`. Packaging uses an explicit file allowlist, rejects symlinks, and generates a hash inventory. Transfer the archive and checksum to the deployment host.

```sh
sha256sum -c annotation-release-001.tar.gz.sha256
tar -xzf annotation-release-001.tar.gz
cd annotation-release-001
./ops.sh verify
cp deploy.env.example deploy.env
chmod 600 deploy.env
```

Configure the exact HTTPS origin, an available loopback port, a unique Compose project and data volume, and an immutable image tag. `deploy.env` accepts plain `KEY=value` entries. `ANNOTATION_DEPLOY_ENV` can select another configuration file.

## Start the application

```sh
./ops.sh config
./ops.sh build
./ops.sh up
./ops.sh status
./ops.sh health
```

The default endpoint is **127.0.0.1:13002**. The container runs without privileges, with a read-only root filesystem and persistent SQLite storage. `up` acts on the annotation service and waits for its health check. Docker 28+ is required for the intended loopback publishing behavior.

## Reverse proxy

For a host proxy, leave `ANNOTATION_PROXY_NETWORK` empty:

```sh
./ops.sh proxy caddy
./ops.sh proxy nginx
```

These commands print configuration fragments. Add the relevant fragment to the existing HTTPS site, validate the complete proxy configuration, and reload it through the host's usual procedure.

For a containerized proxy, configure an existing external Docker network in `ANNOTATION_PROXY_NETWORK` and a unique `ANNOTATION_PROXY_ALIAS`. The application joins that network; the generated upstream is `alias:3002`.

The proxy must preserve `Host`, terminate TLS, and replace `X-Forwarded-For` with a validated client address. The application trusts one proxy hop. A CDN in front of the proxy requires an explicit trust configuration; [Caddyfile.cloudflare](Caddyfile.cloudflare) provides a Cloudflare-oriented template.

```sh
./ops.sh public-health
./ops.sh admin bootstrap 'Coordinator'
```

Create the coordinator only after verifying HTTPS. Bootstrap prints a private reusable invitation. Other invitations are managed in the application.

## Backup and restore

```sh
./ops.sh backup ../backups/annotation-snapshot.sqlite
./ops.sh restore ../backups/annotation-snapshot.sqlite jev-annotation-restore-001
```

Backup captures a consistent SQLite snapshot, including WAL changes, writes a checksum, and refuses to overwrite existing files. Restore checks integrity, invalidates access tokens, and writes into a new volume without replacing the active service.

To activate a restored database, set `ANNOTATION_DATA_VOLUME` to the restored volume, run `./ops.sh up`, and verify health. Coordinator access can be recovered with `./ops.sh admin participants` and `./ops.sh admin invite ID`.

## Upgrades

Keep each release in its own directory with a unique image tag. Verify the new package, preserve the existing project, volume, and origin, take a backup, build the image, and run `./ops.sh up`. A rollback uses the previous release and its retained image. Schema-incompatible changes require restoring a compatible database into a separate volume.

`./ops.sh stop` stops the annotation application. Data volumes should be retained until backup integrity and the applicable retention requirements have been verified.

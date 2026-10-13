# Deployment Guide

## 1. The constraint that shapes every deployment

**CollabWrite runs as a single backend process.**

The lock table, the buffer pool and the WAL writer are in-process data
structures. Two backend instances pointing at the same `documents.dat` would
each believe they hold the only lock table, would cache the same pages in
two unsynchronised buffer pools, and would interleave writes into one log.
The result is corruption, not merely degraded performance.

So the usual horizontal-scaling recipe — several app replicas behind a load
balancer with sticky sessions — is **wrong here** and must not be copied
from a generic Node.js deployment guide. `prd.md` section 8 puts distributed
consensus and multi-node sharding out of scope, and this is the operational
consequence of that decision.

What you can scale:

| Component | Scalable? | How |
|-----------|-----------|-----|
| Frontend (nginx + static files) | yes | Any number of replicas |
| PostgreSQL | yes | Normal replication; it holds only support data |
| Backend + engine | **no** | Exactly one instance per data directory |

To serve more load, raise `ENGINE_WORKERS` and `ENGINE_BUFFER_FRAMES` and
give the process a faster disk. To go beyond one machine, the engine would
need a distributed lock service and a shared log — which is a different
project.

## 2. Local development

```bash
git clone https://github.com/purvanshjoshi/CollabWrite.git
cd CollabWrite
npm install
cp .env.example .env
# set JWT_SECRET to a long random value
```

Without PostgreSQL:

```bash
STORE_DRIVER=memory npm run dev     # API on :3001
npm run client:dev                  # editor on :3000, proxying to :3001
```

With PostgreSQL:

```bash
npm run db:init
npm run db:seed
npm run dev
```

## 3. Docker Compose

```bash
cp .env.example .env
npm run docker:up
docker compose ps
```

| Service | Port | Role |
|---------|------|------|
| `frontend` | 3000 | nginx serving the built React app, proxying `/api` and `/socket.io` |
| `backend` | 3001 | Express, Socket.IO and the engine |
| `postgres` | 5432 | Support store; schema and seed applied on first start |

There is no Redis. It appears nowhere in `architecture.md`, and a cache or
pub/sub layer would only be needed for the multi-instance deployment that
section 1 rules out.

### Volumes

| Volume | Contents | Losing it means |
|--------|----------|-----------------|
| `enginedata` | `documents.dat`, `wal.log`, `index.dat`, `metrics.log` | Every document is gone |
| `pgdata` | PostgreSQL | Accounts and permissions are gone |

`enginedata` is a named volume, not a bind mount, so a `docker compose down`
without `-v` keeps it. **`docker compose down -v` destroys every document.**

### Production target

The compose file builds the `development` stage by default. For a
production-like image:

```bash
BACKEND_TARGET=production NODE_ENV=production npm run docker:up
```

The production stage installs only runtime dependencies, copies `src`,
`database` and `scripts`, and runs as the unprivileged `node` user.

## 4. Health checks and start-up ordering

`GET /health` returns `status: "starting"` until crash recovery has
completed, and `"ok"` afterwards. The backend health check uses this.

The ordering in `src/server/index.js` is load-bearing:

1. Open the support store.
2. Start the engine, which **runs crash recovery before anything else**.
3. Only then bind the listeners.

An orchestrator that routes traffic to a container before recovery finishes
would let a client read a page that is about to be rolled back. Any
readiness probe must wait for `"ok"`, never merely for the port to open.

## 5. Kubernetes

Deployable, with constraints that follow directly from section 1:

```yaml
apiVersion: apps/v1
kind: StatefulSet            # not a Deployment: stable identity and storage
metadata:
  name: collabwrite-backend
spec:
  replicas: 1                # MUST be 1; see section 1
  serviceName: collabwrite-backend
  template:
    spec:
      containers:
        - name: backend
          image: collabwrite-backend:latest
          ports:
            - containerPort: 3001
          env:
            - name: ENGINE_DATA_DIR
              value: /var/lib/collabwrite
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef: { name: collabwrite-secrets, key: jwt-secret }
          volumeMounts:
            - name: enginedata
              mountPath: /var/lib/collabwrite
          readinessProbe:
            httpGet: { path: /health, port: 3001 }
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /health, port: 3001 }
            initialDelaySeconds: 30
            periodSeconds: 20
  volumeClaimTemplates:
    - metadata: { name: enginedata }
      spec:
        accessModes: [ "ReadWriteOnce" ]
        resources: { requests: { storage: 10Gi } }
```

Required choices, and why:

- **StatefulSet with `replicas: 1`.** A Deployment's rolling update briefly
  runs two pods, which would mean two engines on one volume.
- **`strategy: Recreate`** if a Deployment is used anyway — the old pod must
  terminate before the new one starts.
- **`ReadWriteOnce`** is correct precisely because only one pod may mount it.
- **No `podAntiAffinity` tricks or HPA.** Autoscaling this workload would
  corrupt it.

The readiness probe is what makes a restart safe: the new pod is kept out of
the Service until recovery has replayed the log.

## 6. Reverse proxy

`docker/nginx.conf` is the working example. The parts that matter:

```nginx
location /socket.io/ {
    proxy_pass http://collabwrite_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

WebSocket needs the upgrade headers and a generous read timeout. Sticky
sessions are not required, because there is only one backend to be sticky
to.

For TLS, terminate at the proxy and set `CLIENT_ORIGIN` to the public
origin.

## 7. Backup and restore

```bash
docker compose stop backend     # quiesce first; see below
docker run --rm -v collabwrite_enginedata:/data -v "$PWD:/backup" alpine \
  tar czf /backup/engine-$(date +%F).tar.gz -C /data .
docker compose exec -T postgres pg_dump -U collabuser collabwrite > db-$(date +%F).sql
docker compose start backend
```

Stopping the backend first is not optional. Copying `documents.dat` while a
write is in flight can capture a torn page; the checksum would detect it on
restore, but the page would still be lost. Taking the PostgreSQL dump in the
same window also keeps metadata consistent with the engine snapshot.

Restore in the same order: engine files, then the database, then start the
backend and let recovery run.

## 8. Pre-deployment checklist

- [ ] `JWT_SECRET` set to a long random value, not the placeholder
- [ ] Seed data **not** loaded (`password123` accounts, one of them admin)
- [ ] `CLIENT_ORIGIN` set to the real origin, not `*`
- [ ] `WAL_SYNC_ON_COMMIT=true`
- [ ] `ENGINE_DATA_DIR` on persistent storage, backed up
- [ ] `ENGINE_BUFFER_FRAMES` comfortably above `ENGINE_WORKERS`
- [ ] Exactly one backend instance per data directory
- [ ] Readiness probe waits for `status: "ok"`, not just an open port
- [ ] TLS terminated in front of the service
- [ ] A plan for WAL growth, since log truncation is not implemented

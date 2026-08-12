# Retro Cloud — Auditoría del Core y Gestión en Cloud Profesional

> Documento vivo: auditoría de calidad/rendimiento del game-server + plan de despliegue
> escalable, multi-nube (AWS / GCP / Azure), con gestión de costes y operaciones.

---

## 1. Visión general de la arquitectura

| Capa | Componente | Tecnología | Rol |
|------|-----------|-----------|-----|
| Emulación | `game-server` | C++20 + libretro + GStreamer + webrtcbin | Emula, codifica H.264/Opus, publica WebRTC P2P |
| Señalización | `signaling` | Node 22 + ws + pg | WebSocket SDP/ICE relay, API REST, *spawning* de containers Docker |
| Frontend | `web` | React 19 + Vite | Reproductor WebRTC, input teclado/gamepad/touch, lobby |
| Datos | `postgres` | Postgres 16 | Usuarios, sesiones, amigos, DMs, ROMs compartidos |
| NAT | `coturn` | coturn | TURN relay para symmetric NAT |

**Modelo de despliegue actual:** un único VPS (Oracle Cloud, IP 23.138.88.186) corre `docker-compose.yml` con 4 servicios. Cada *room* spawnnea un container Docker con `network_mode: host`, limitado a 1–3 CPU (NanoCpus) y 1 GiB de RAM. Máximo 4 rooms concurrentes.

---

## 2. Auditoría del game-server core (calidad y red)

### 2.1 Hallazgos críticos de calidad

#### 2.1.1 (CRÍTICO) Excepciones lanzadas desde callbacks de libretro — crash garantizado
**Archivo:** `game-server/src/main.cpp` → `video_refresh` llama a `webrtc_pipeline->push_rgba(...)`
**Archivo:** `game-server/src/video/webrtc_pipeline.cpp` → `push_rgba` (línea 350)

```cpp
if (gst_app_src_push_buffer(GST_APP_SRC(source_), buffer) != GST_FLOW_OK) {
    throw std::runtime_error("webrtcbin appsrc rejected video frame");  // línea 350
}
```

`video_refresh` es un callback invocado por `retro_run()` (libretro). Lanzar una excepción C++ a través de una frontera C es **comportamiento indefinido**. Si el codificador se retrasa y el `appsrc` (max-buffers=1, leaky) rechaza el buffer, la excepción atraviesa el core libretro, `run()`, y el `while` de `main` → **el proceso muere** y la partida se cae para todos los jugadores.

**Remedio:** convertir los `throw` en `return` + logging + contador de frames dropped. Nunca lanzar desde un callback. `push_pcm` ya lo hace bien (registro + `return`); `push_rgba` debe seguir el mismo patrón.

#### 2.1.2 (CRÍTICO) Sin manejador de señales → cierre brusco en SIGTERM/SIGKILL
**Archivo:** `game-server/src/main.cpp` → `main` (línea 345)

El `run()` loop comprueba `steady_clock::now() < stop_at` pero **no instala manejadores de SIGINT/SIGTERM**. Cuando `teardownRoom()` llama `container.stop()` (Docker envía SIGTERM, espera 10s, luego SIGKILL), el proceso no ejecuta `webrtc_pipeline->stop()`, `signaling_client->close()` ni `gst_element_set_state(NULL)`. Esto deja:
- Sockets/zombies en el plano de señalización.
- Elementos de GStreamer sin liberar.
- El container se cuelga 10s en cada shutdown.

**Remedio:** instalar `signal(SIGTERM, ...)` / `signal(SIGINT, ...)` con un `std::atomic<bool> should_exit` que el loop compruebe, y un `atExit`/RAII que llame los `stop()`.

#### 2.1.3 (ALTO) El bitrate está fijado al *spawn* y nunca se adapta
**Archivo:** `signaling/src/server.ts` → `videoBitrateByTier` (línea 179), `spawnGameServer` (línea 181)

```ts
const videoBitrateByTier: Record<string, string> = { high: "2500K", medium: "1500K", low: "700K" };
```

El bitrate del `x264enc` se escribe en el pipeline de GStreamer una sola vez al iniciar el container. No hay estimación de ancho de banda Web (TWCC) ni ajuste dinámico. Si un room de "high" (2.5 Mbps) recibe jugadores en móvil 4G, todos se sufren. El comentario en `webrtc_pipeline.cpp` lo reconoce: *“there's no per-peer bandwidth estimation”*.

**Remedio:** exponer `x264enc bitrate` como un *property* modificable en caliente, y que el *host* pollitee `RTCP REMB` / `Transport-wide CC` del `webrtcbin` para ajustarlo. Mínimo viable: el cliente reporta `availableIncomingBitrate` vía data channel y el server reconfigura el encoder.

#### 2.1.4 (ALTO) Credenciales TURN expiran antes que la vida del container
**Archivo:** `signaling/src/server.ts` → `turnTtlSeconds = 3600` (línea 384) vs `MAX_GAME_SERVER_LIFETIME_MS = 4h` (línea 281)

Las credenciales TURN HMAC se generan con TTL de 1 hora (`generateTurnCredentials`). El container puede vivir 4 horas (`MAX_GAME_SERVER_LIFETIME_MS`). Pasada la 1.ª hora, el `webrtcbin` del game-server usa credenciales TURN inválidas → en symmetric NAT el ICE falla y la *media se corta*. El *browser* sí refresca (`/turn` en cada connect) pero el *server* no.

**Remedio:** reducir `MAX_GAME_SERVER_LIFETIME_MS` a ≤ 50 min, o regenerar y *push* credenciales nuevas al game-server cada 50 min vía canal de control, o refrescar en el *browser* y propagar al *server*.

#### 2.1.5 (MEDIO) Sin monitoring/observabilidad del game-server
El game-server solo loguea métricas cada 1s (`frames`, `samples`) con `std::cout`. No hay:
- Contador de frames *dropped* (neither in encoder ni en appsrc rechazo).
- Medición de *glass-to-glass* (no hay RTCP sender reports expuestos).
- Exportación Prometheus (`/metrics`).
- Latencia de input-to-display.

**Remedio:** exponer `/metrics` (Prometheus) o un endpoint de stats en el signaling; el game-server reporta stats vía el data channel o por polling.

### 2.2 Hallazgos de calidad en el *input path*

#### 2.2.1 (ALTO) DataChannel `ordered=FALSE` → *input ghosting* por reordenamiento
**Archivo:** `game-server/src/video/webrtc_pipeline.cpp` → `add_peer` (línea 291-293)

```cpp
auto *options = gst_structure_new("options", "ordered", G_TYPE_BOOLEAN, FALSE,
    "max-retransmits", G_TYPE_INT, 0, nullptr);
```

El data channel es **desordenado sin retransmit**. El browser envía un *bitmask* completo por cada *press/release* solo cuando cambia (`sendInput` en `App.tsx` línea 1737). Si dos eventos se reordenan (ej: release A llega antes que press A), el mask viejo revive el botón. Con contenido de juego rápido (combos) esto produce *inputs fantasma*.

**Remedio 1 (mínimo):** `ordered=TRUE, max-retransmits=0` — preserva orden, dropea paquetes *late*, sin *head-of-line blocking* de retransmisión. Ésta es la opción estándar para input de juegos sobre SCTP.

**Remedio 2 (ideal):** añadir un *sequence counter* de 16/32 bits al mensaje `[0xFF, seq_lo, seq_hi, mask_lo, mask_hi]` y descartar paquetes *out-of-order* en `on_data_channel_message`.

#### 2.2.2 (MEDIO) Sin timestamps de input → imposible compensar latencia de red
El `send_buf` del browser es `[0xFF, mask_lo, mask_hi]` — no lleva timestamp. El *server* aplica el input al frame siguiente sin saber cuándo ocurrió realmente. Para juegos precisos (fighting) se debería interpolar.

### 2.3 Hallazgos de rendimiento de CPU / memoria

#### 2.3.1 (ALTO) `std::vector::assign` + `memset` de todo el framebuffer cada frame
**Archivo:** `game-server/src/main.cpp` → `video_refresh` (línea 180)

```cpp
runtime.framebuffer.assign(static_cast<std::size_t>(canvas_width) * canvas_height * 4, 0);
```

Cada frame (60 Hz) se *zero-fill* el framebuffer completo (640×480×4 = 1.2 MB → 72 MB/s de `memset`) **antes** de escribir todos los píxeles en el bucle de conversión. Además, el bucle de conversión (líneas 181-228) es **escalar, sin SIMD**: ~72–580 Mops/s (duplicado para upscale 2×). Esto compite con el core libretro y `x264enc` por el mismo budget de CPU (NanoCpus).

**Remedio:** usar `libyuv` (SIMD) o `swscale` para la conversión/upscale, o mover a GPU con `vaapi`/`cuda` en el pipeline GStreamer (`vaaconvert`/`cudaconvert` + `x264enc` o `nvenc`). Reutilizar el `framebuffer` (resize solo cuando cambie el canvas).

#### 2.3.2 (MEDIO) Re-allocación redundante de `framebuffer_scaled`
Aunque `resize()` no realloca si el tamaño no cambia, el bucle de *nearest-neighbor* (líneas 222-228) usa `std::memcpy` fila a fila — 60 iteraciones de memcpy por frame. Funciona pero es menos eficiente que un único `memcpy` con stride o un shader.

#### 2.3.3 (BAJO) `x264enc` con CPU-bound `threads=2` en container con NanoCpus
`game-server/src/video/webrtc_pipeline.cpp` línea 148: `threads=2 sliced-threads=true`. Está bien comentado, pero para PS1 (3 CPUs) el `x264enc` compite con el core. Con `speed-preset=ultrafast` la codificación es liviana, pero no hay *GPU encoder* disponible.

### 2.4 Resumen de auditoría de red (latencia de extremo a extremo)

El game-server ya aplica varias técnicas de baja latencia correctas:

| Técnica | Archivo | Estado |
|---------|---------|--------|
| `latency=0` en webrtcbin | `webrtc_pipeline.cpp:244` | ✅ Implementada |
| `key-int-max = 2s` (IDR periódico) | `webrtc_pipeline.cpp:150` | ✅ Implementada |
| `bframes=0` | `webrtc_pipeline.cpp:151` | ✅ Implementada |
| `sliced-threads=true` | `webrtc_pipeline.cpp:149` | ✅ Implementada |
| `zerolatency` tuning | `webrtc_pipeline.cpp:148` | ✅ Implementada |
| `vbv-buf-capacity=120` | `webrtc_pipeline.cpp:149` | ✅ Implementada |
| `playoutDelayHint=0` (browser) | `App.tsx:1210` | ✅ Implementada |
| `video.latency="realtime"` (browser) | `App.tsx:1218` | ✅ Implementada |
| `leaky=downstream` queues | `webrtc_pipeline.cpp:247-248` | ✅ Implementada |
| `should_forward_candidate` filtra IPs | `webrtc_pipeline.cpp:61-67` | ✅ Implementada |
| **Estimación ancho de banda (TWCC/REM)** | — | ❌ No implementada |
| **Adaptación dinámica de bitrate** | — | ❌ No implementada |
| **Audio sync (AEC/clock drift)** | — | ❌ No implementada |

**Latencia teórica típica (red local):** ~80–120 ms (emulación + encode + red + jitter buffer).  
**Latencia en internet pública:** ~150–300 ms con TURN.

---

## 3. Gestión en cloud profesional

El paso de un solo VPS a una arquitectura multi-nube requiere resolver 3 *hard constraints* del diseño actual:

1. **El signaling server depende del *Docker socket*** (`/var/run/docker.sock`) para spawnear containers — no es portable a plataformas serverless ni seguras.
2. **El estado es in-memory** (rooms, peers, rate limits, max-concurrent) — no tolera *horizontal scaling*.
3. **Los ROMs/BIOS están en un volumen local** — no son compartibles entre hosts.

### 3.1 Arquitectura cloud-native recomendada

```
                      ┌──────────────────────────────────────────┐
                      │         CDN (CloudFront / Cloud CDN)        │
                      │   Static assets (web build, ROM thumbnails) │
                      └─────┬───────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼              ▼             ▼
        ┌─────────┐   ┌────────┐   ┌────────────┐
        │  WAF    │   │  ALB   │   │  Global    │
        │ (Cloud   │   │ (K8s   │   │ Accelerator│
        │ Armor/   │   │ Service│   │ (GCP)/     │
        │ Firewall)│   │ / LB)  │   │ Azure Front)│
        └────┬────┘   └────┬───┘   └──────┬─────┘
             │             │              │
    ┌────────┴────────┐    │    ┌─────────┴────────┐
    │  Redis (Elasti- │    │    │  Redis (Memorystore│
    │ cache/Memorystore) │   │    │ / Azure Cache)    │
    └────────┬────────┘    │    └─────────┬────────┘
             │             │              │
             ▼             ▼              ▼
    ┌──────────────────────────────────────────┐
    │        Signaling (Node.js, stateless      │
    │        N replicas ←→ Redis shared state)  │
    └──────┬────────────────────────────┬──────┘
           │                            │
    ┌──────┴──────┐          ┌─────────┴──────────┐
    │  Web (React │          │  Web (React, extra │
    │  static,    │          │  region)           │
    │  Vite CSR)  │          │                    │
    └──────┬──────┘          └─────────┬──────────┘


    ┌──────┴────────────────────────────┴─────────────────────────┐
    │                    Game-Server Layer                         │
    │                                                            │
    │  Regional pool:                                            │
    │  ┌──────────────────┐  ┌──────────────────┐                │
    │  │ EC2/VM worker    │  │ EC2/VM worker    │  ...           │
    │  │ hostNetwork:true │  │ hostNetwork:true │                │
    │  │ Docker/socket    │  │ Docker/socket    │                │
    │  │ or K8s Operator  │  │ or K8s Operator  │                │
    │  └──────┬───────────┘  └──────┬───────────┘                │
    │         │ game-server pods     │                            │
    │         │ (hostNetwork, UDP)   │                            │
    │         └──────────────────────┘                            │
    │                                                            │
    │  ┌──────────────────────────────────────────┐              │
    │  │ Coturn DaemonSet (one per worker node)    │              │
    │  │  UDP 3478 + 49152-65535 (relay range)    │              │
    │  └──────────────────────────────────────────┘              │
    └────────────────────────────────────────────────────────────┘
           │
    ┌──────┴──────┐
    │ Postgres    │  (RDS / Cloud SQL / Flexible Server)
    │ (managed)   │  Multi-AZ, read replicas, backups
    └─────────────┘
    ┌──────┴──────┐
    │ Object      │  (S3 / Cloud Storage / Blob)
    │ Storage     │  ROMs, BIOS, saves
    └─────────────┘
```

### 3.2 Gestión de estado compartida (Redis)

| Estado actual (in-memory) | Migración a Redis |
|---|---|
| `peers` Map (WebSocket connections) | **Mantener in-memory por instancia** + Sticky sessions (o Redis Pub/Sub para *presence* broadcast entre instancias). Los WebSockets son inherentemente stateful; usar *session affinity* en el ALB o migrar a un broker (Redis Streams / Kafka) si se quiere escalar sin sticky. |
| `rooms`, `managedRooms`, `roomOwners`, `roomVisibility`, `roomFiles` | Mover a Redis Hashes (`room:{id}` → hash con owner, game, container_id, spawn_time, ...) + `SET` de rooms activos. Necesario para que cualquier instancia de signaling pueda teardownar. |
| `roomOwners`, `state.usedNumbers` | `room:players` set + `room:owner` key. |
| `rateLimits` (sliding window) | Redis + `INCR` + `EXPIRE` por clave (`rl:login:ip`, `rl:room:user`, `rl:upload:user`). |
| `MAX_CONCURRENT_GAME_SERVERS` por instancia | Contador global en Redis (`INCR game-servers-active`) con *distributed lock* o `SETNX` + TTL. |
| `romOwnersCache` | Leer directamente de Redis (DB de owners) en vez de FS. |

**Configuración de Redis por proveedor:**
- **AWS:** ElastiCache for Redis (cluster mode habilitado). `cache.t3.micro` para dev, `cache.m7g.large` para prod.
- **GCP:** Memorystore for Redis (Standard tier, no cluster mode en v1; usar t2a). 
- **Azure:** Azure Cache for Redis (Standard o Premium).

### 3.3 Almacenamiento de ROMs y BIOS

Los ROMs son privados por usuario (propiedad → compartidos). La opción más scalable:

| Opción | AWS | GCP | Azure |
|---|---|---|---|
| **Object storage** | S3 (privado por usuario con IAM) | Cloud Storage (Signed URLs) | Blob Storage (SAS) |
| **CDN** | CloudFront (origen S3) | Cloud CDN | Azure CDN |
| **Subida** | S3 presigned POST (directo browser→S3) | GCS resumable upload | Blob SAS PUT |
| **Lectura game-server** | S3 mount (s3fs/goofys) o fetch HTTP | GCS FUSE o Signed URL | Blob SAS |

**Recomendación:** subidas directas browser→object-storage con *presigned URLs* (evita cargar tráfico de ROMs por el signaling). El game-server container monta el bucket (s3fs/gcsfuse/azfs) en `/roms` y `/system`. Las BIOS (pequeños, compartidos) pueden ir en un bucket separado público/privado.

### 3.4 Orquestación de game-servers

Esta es la pieza más delicada: **WebRTC necesita que el game-server tenga conectividad UDP directa o vía TURN.** No se puede poner un load-balancer TCP/UDP delante de muchos game-servers porque cada media flow es P2P al host que lo emite.

#### Opción A: Kubernetes con `hostNetwork: true` + DaemonSet de coturn

- Cada *worker node* (EC2/GCE VM con IP pública) corre un `coturn` DaemonSet y pods de game-server con `hostNetwork: true`.
- El `webrtcbin` expone UDP en el puerto del nodo (host network). El browser hace ICE → host IP.
- Un **operador personalizado** (o [Agones](https://agones.dev)) reemplaza a `spawnGameServer`: en vez de `docker.createContainer`, crea un `GameServer` CRD → K8s schedulea el pod.
- **Ventaja:** autoscaling de nodos (Cluster Autoscaler) añade/quita VMs según demanda de pods.
- **Desventaja:** IP pública por nodo (o usar `NodePort` + `externalTrafficPolicy: Local` para preservar IP). Necesita `securityGroup` abierto para UDP 3478 + relay range 49152-65535.

#### Opción B: Auto Scaling Group (ASG) de VMs worker con agente

- Un ASG de EC2/VMs dedicadas (c5a/c6a, con CPU suficiente para PS1).
- Un **agente** (Node.js o Go) corre en cada VM: escucha un *job queue* (SQS/Cloud Tasks/Service Bus) y spawnnea containers Docker locales con `network_mode: host`.
- El signaling publica `create-room` en la queue → el agente más cercano (least-loaded) despacha el game-server.
- **Ventaja:** menos complejidad que K8s; el agente puede ser el mismo `dockerode` pero corriendo *dentro* del worker (no desde signaling).
- **Desventaja:** gestión manual del autoscaling + rollout del agente.

#### Opción C: ECS con EC2 + host networking (AWS-only)

- Task Definition con `networkMode: host`, `pidMode: host`, `privileged` para acceder a `/dev` (GPU) y puertos UDP.
- ECS Service + Capacity Provider sobre un Auto Scaling Group de EC2.
- **Ventaja:** managed en AWS, integración nativa.
- **Desventaja:** EC2 (no Fargate) por host networking; vendor lock-in.

> **Nota sobre GPU:** El game-server actual usa codificación *software* (`x264enc`). Si se quiere hardware encoding (`nvenc`/`vaapi`), los workers deben tener GPU. Esto complica el autoscaling (instancias `g4dn`/`GCE GPU`/`NV-series`) y sube los costes. Se puede ofrecer *CPU-only* (baseline) y *GPU* (premium tier) pools separados.

### 3.5 Distribución geográfica / regional

| Concepto | Implementación |
|---|---|
| **Edge location** | Desplegar el *control plane* (signaling + web + redis + postgres) en 2-3 regiones (ej: `us-east-1`, `eu-west-1`, `ap-southeast-1`). |
| **Game-server regional pool** | Un pool de workers *por región*. El browser mide RTT al `/ping` y el signaling asigna el room al pool de la región más cercana. |
| **Coturn regional** | Un coturn por región (o por AZ). El browser recibe la lista ICE con la IP regional. |
| **Database replication** | Postgres con read-replicas en cada región + *write forwarding* al primary. O usar *CockroachDB*/*Spanner* para multi-región. |

---

## 4. Escalabilidad

### 4.1 Horizontal

| Componente | Estrategia | Límite |
|---|---|---|
| **Web (React)** | Estático → CDN global (CloudFront/Cloudflare). 100% cacheable. Infinito. |
| **Signaling** | N réplicas detrás de ALB. Stateful WebSockets → *sticky sessions* o migrar a Redis Streams. Rate-limiting distribuido con Redis. |
| **Game-server** | Pool de workers con autoscaling. Cada room = 1 processos. Limitar por CPU (PS1 ~1 proceso/3 vCPU). Escalar workers horizontalemente. |
| **Postgres** | Read replicas para `/rooms`, `/roms`, `/friends`. Writes en primary. Particionar `messages` por created_at. |
| **Redis** | Cluster mode para escalarBeyond 1 node. Sharding por prefijo. |

### 4.2 Vertical (por room)

| Recurso | NES/SNES | PS1 | Ajuste |
|---|---|---|---|
| CPU | 1 vCPU (NanoCpus=1e9) | 3 vCPU (NanoCpus=3e9) | Ya parametrizado en `spawnGameServer`. |
| RAM | 1 GiB | 1 GiB (quizá subir 1.5 para PS1) | `Memory: 1024*1024*1024`. |
| **Video bitrate** | 700K–2500K según tier | 700K–2500K | Sin adaptación dinámica (ver 2.1.3). |
| **Players máx** | 4 (const `kMaxPlayers`) | 4 | Hardcodeado en C++. |

### 4.3 Escalado elástico (autoscaling)

```yaml
# Ejemplo: ECS Service con Capacity Provider
Service:
  DesiredCount: 0          # scale to zero when idle
  Scaling:
    - Metric: SQSQueueDepth (pending room jobs)
      Min: 0, Max: 50 workers
      Scale-out: +5 workers / min
      Scale-in: -1 worker / 5 min (cooldown)
```

- **Trigger de escala:** número de *room jobs* pendientes en la SQS, o `peers waiting > 10s` en signaling.
- **Scale to zero:** cuando no hay rooms activos, los workers pueden terminar (savings). El signaling mantiene su propio ASG a 1 (nunca scale a 0).
- **Cooldown de nodos:** evitar flapping — un worker recién spawneado tarda ~20s en estar ready (pull image + iniciar).

### 4.4 Escalado de media (WebRTC)

El modelo actual es **1:N (broadcast P2P)**: un game-server codifica una sola transmisión y `tee` la reparte a todos los peers. Esto es eficiente — el coste de N viewers es ~N×(encode no, solo send UDP). No hay need de SFU.

Para **escalado masivo** (hundreds de viewers en un room), se puede introducir un **SFU intermedio** (mediasoup/janusai) que recibe del game-server y re-distribuye, pero añade 1 salto y complejidad. **No es necesario** a menos de superar 10–20 viewers concurrentes por room.

---

## 5. Gestión de costes

### 5.1 Modelo de costes por componente

| Componente | AWS (ej. us-east-1) | GCP (us-central1) | Azure (East US) | Notas |
|---|---|---|---|---|
| **Game-server worker (CPU)** | `c5.xlarge` ($0.17/h) o `c5a.2xlarge` ($0.34/h) | `e2-standard-4` ($0.13/h) | `B4ms` ($0.188/h) | PS1 necesita ≥3 vCPU. NES/SNES 1 vCPU basta. Spot/preemptible para workers. |
| **Game-server worker (GPU)** | `g4dn.xlarge` ($0.53/h) | `a2-highgpu-1g` ($0.80/h) | `NVv4` ($0.40/h) | Solo si se habilita NVENC. |
| **Signaling** | `t4g.small` ($0.0208/h) × N réplicas | `e2-micro` ($0.0084/h) | `B1S` ($0.012/h) | CPU baja; el coste es Redis + Postgres. |
| **Web (estático)** | CloudFront + S3 (< $5/mes) | Cloud CDN + Storage (< $5) | CDN + Blob (< $5) | 100% en caché. |
| **Redis** | ElastiCache `cache.t3.micro` ($0.019/h) | Memorystore `redis-single-zone` (< $10/mes) | Basic Redis ($15/mes) | Standard para HA. |
| **Postgres** | RDS `db.t4g.micro` ($0.017/h) | Cloud SQL `db-f1-micro` ($0.011/h) | Flexible `B_S_Gen5_1` ($0.016/h) | Multi-AZ + backup dobla el coste. |
| **Object storage (ROMs)** | S3 (0.023 $/GB/mes) | Cloud Storage (0.02/h) | Blob ($0.0184/GB) | Tráfico outbound es el coste mayor. |
| **Coturn (VMs)** | VM compartida + puertos abiertos | Igual | Igual | Puede compartir VM con signaling. |
| **Bandwidth (egress)** | $0.09/GB (hasta 10TB) | $0.12/GB | $0.087/GB | **El coste dominante** para media. |

### 5.2 Análisis de costes para un room típico (1h de juego)

Supongamos 1 room NES, 3 viewers, 1500 Kbps de video:

```
Datos de video: 1.5 Mbps × 3 viewers × 3600s = 1.687 GB × 3 = 5.06 GB
Datos de audio: (40 kbps × 3 × 3600) ≈ 0.05 GB
Input: ~0.001 GB
Total egress por room/hora: ~5.1 GB → $0.46/GB (AWS) ≈ $2.35/room/hora
```

**El 80% del coste es bandwidth de salida.** El signaling/postgres/redis son marginales (~$0.10/room/hora).

**Estrategia de ahorro:**
1. **Region nearest:** servir desde la región más cercana al viewer reduce RTT y a veces tariffs (inter-region egress es más caro).
2. **Bitrate adaptativo:** el browser negocia `RTCP REMB` → si detecta congestion, bajar el bitrate del `x264enc`. (Ver 2.1.3 — no implementado; *priority alta*.)
3. **Preload + idle timeout:** si un room no tiene players, el game-server se apaga tras 5 min (ya existe `MAX_GAME_SERVER_LIFETIME_MS`, pero también *idle timeout* de container sin connections).
4. **Spot instances para workers:** game-server es efímero y tolera terminación (se crea uno nuevo). `c5.xlarge spot` (~$0.05/h, 70% discount). **Alerta:** terminar un spot destruye el juego en curso → tolerar solo para queues, no rooms activos.
5. **Reserved instances / Committed use:** reservar 1-3 hosts base siempre encendidos (signaling + workers base) y spot para picos.

### 5.3 Presupuesto orientado a usuarios

| Tier | Coste/room/hora (AWS) | Precio sugerido | Margen |
|---|---|---|---|
| Free (1 Mbps, 2 viewers) | $1.50 | $3.99 | ~60% |
| Pro (2 Mbps, 4 viewers) | $3.20 | $7.99 | ~60% |
| Premium (4 Mbps, 6 viewers) | $7.60 | $14.99 | ~50% |

> Los números incluyen: bandwidth (dominante), worker EC2, signaling, redis, postgres, storage. No incluyen: IVA, margen de plataforma, soporte.

---

## 6. Operaciones (DevOps / SRE)

### 6.1 CI/CD

```
GitHub Actions / CodePipeline / Cloud Build
  │
  ├── build game-server image (multiarch: amd64+arm64)
  │     docker buildx → registry (ECR/Artifact Registry/ACR)
  │     Tag: semver + latest
  │
  ├── build signaling image
  │     npm ci → tsc → docker build → registry
  │
  ├── build web image
  │     npm ci → vite build → serve static → registry (o direct-to-S3 para SPA)
  │
  ├── deploy infra (Terraform / Pulumi / CDK)
  │     VPC, subnets, RDS, Redis, ASG, ALB, CloudFront, IAM
  │
  └── deploy app (Helm / ECS Service / GHA)
        signaling (N replicas), web (N), game-server worker pool (auto)
```

**Multi-arch:** el `Dockerfile` del game-server ya está preparado para `linux/amd64` y `linux/arm64` (ver `docs/development.md` línea 26). Usar `docker buildx` con `qemu` o builds nativos por arquitectura.

### 6.2 Observabilidad

| Layer | Herramienta | Métricas clave |
|---|---|---|
| **Infra** | CloudWatch / Cloud Monitoring / Azure Monitor | CPU/mem/network/disk, uptime host. |
| **Container** | Prometheus + Grafana (o CloudWatch Container Insights) | CPU throttle, restarts, OOM. |
| **Game-server** | Prometheus export (añadir) | frames_encoded, frames_dropped, encode_fps, input_rtt, webrtc_connection_state, peers_connected, bitrate_actual_kbps. |
| **Signaling** | Winston/Bunyan log → CloudWatch / stdout | requests, ws_connections, room_spawn_latency, docker_spawn_errors, rate_limit_hits. |
| **Browser** | Web vital stats (CLS, FID) + WebRTC getStats() | RTT, jitter, packetLoss%, decodedFrames, freezeCount. Enviar al signaling vía /metrics o beacon. |
| **Log aggregation** | CloudWatch Logs / Cloud Logging / Loki | Correlación room_id + trace_id entre signaling → game-server. |

**Alertas críticas:**
- `game-server` restart rate > 1/min → posible OOM o encoder crash.
- `peers waiting > 10s` → game-server no inicia (image pull, core load fail).
- `CPU > 85%` por > 5 min en worker → escalar o terminar room.
- `TURN relay bytes > 90% quota` → necesario más workers/regiones.
- `Postgres CPU > 70%` → queries lentas (el `listRoms` con `stat` por archivo es un *N+1* — ver 2.1.1).

### 6.3 Backups y disaster recovery

| Asset | Estrategia |
|---|---|
| **Postgres** | RDS automated backups (7–35 días) + cross-region snapshot. O Cloud SQL automated backups. |
| **Redis** | AOF every-1s + `appendfsync everysec`. Backup periódico a S3. |
| **ROMs/BIOS** | Versioned object storage (S3 con versioning). Elimina el `.owners.json` local → usa tabla DB. |
| **Game-server image** | Registry versionado; *never* `latest` en prod. |
| **Runbooks** | 1. `teardownRoom` force → 2. redeploy signaling → 3. reconcilo orphans → 4. health check. |

### 6.4 Seguridad

- **IAM mínima:** signaling solo necesita `ec2:RunInstances`/`ecs:RunTask` + `s3:GetObject` para ROMs del usuario + `turn` (no full EC2 admin). Actualmente abre el Docker socket (⚠️ *root equivalent*).
- **Secrets:** TURN_SHARED_SECRET, DB password, JWT secret → AWS Secrets Manager / GCP Secret Manager / Azure Key Vault. No en env files planos.
- **Network:** Security groups abiertos solo UDP 3478 + 49152–65535 en workers; TCP 80/443/8080 en signaling; Postgres en private subnet.
- **DDoS / abuse:** WAF en frente del ALB (AWS WAF/Cloud Armor/Azure DDoS). Rate-limit en `/auth/*` y `/roms POST`. Ya existe rate-limit in-memory → migrar a Redis (ver 3.1).
- **CORS:** el signaling pone `Access-Control-Allow-Origin: *`. En prod restringir al dominio real.

### 6.5 Deployments sin downtime

- **Signaling:** blue/green con ALB target groups. Drain connections (WebSocket close grace period).
- **Game-server worker:** rolling update del ASG/ECS Service. Los rooms activos se *migran* (reconnect con el mismo room_id) al nuevo pool — el browser re-hace el WebSocket al nuevo signaling y el *host transfer* (`transfer_host`) reasigna ownership.
- **Rom/Bios:** versionado en objeto storage → sin redeploy.

---

## 7. Matriz provider-vs-característica

| Característica | AWS | GCP | Azure |
|---|---|---|---|
| **Container orchestrator** | ECS (EC2) / EKS / App Runner | Cloud Run (⚠️ no host networking) / GKE | ACI (⚠️) / AKS / App Service |
| **Host networking UDP** | ✅ EC2 / ECS EC2 / EKS hostNetwork | ✅ GCE VMs / GKE hostNetwork | ✅ VMSS / AKS hostNetwork |
| **Object storage** | S3 | Cloud Storage | Blob |
| **Managed Redis** | ElastiCache (Redis) | Memorystore (Redis) | Azure Cache (Redis) |
| **Managed Postgres** | RDS | Cloud SQL | Azure Database for Postgres |
| **UDP Load Balancer** | NLB (con client IP preservation) | N/A (usa host network) | N/A |
| **Spot / preemptible** | EC2 Spot / Spot Fleet | Preemptible VMs / Sole-tenant | Spot VMs |
| **GPU instances** | g4dn / g5 | a2 / a2-ultragpu | NVv4 / NDv5 |
| **CDN** | CloudFront | Cloud CDN | Azure CDN |
| **DDoS protection** | Shield Standard/Advanced | Cloud Armor | DDoS Protection |
| **IaC** | CDK / Terraform / CloudFormation | Terraform / Deployment Manager | Bicep / Terraform / ARM |
| **Observability** | CloudWatch + X-Ray | Cloud Monitoring + Trace | Azure Monitor |

### Recomendación de provider base

| Prioridad | Provider | Justificación |
|---|---|---|
| **Simplicidad → rápido** | **AWS** | ECS + ALB + RDS + ElastiCache + S3 forman un stack "todo gestionado" con menos piezas que K8s. NLB soporta UDP para el coturn. |
| **Mejor precio (CPU)** | **GCP** | `e2-standard-4` es ~30% más barato que `c5.xlarge`; `e2-micro`/`f1-micro` para signaling. Pero Cloud Run no sirve para game-servers. |
| **GPU más barata** | **GCP** | `a2-highgpu-1g` vs `g4dn` — GCP gana en precio/VRAM. |
| **Menor *vendor lock-in*** | **K8s en cualquiera** | Usa Terraform + Helm; desplazable entre EKS/GKE/AKS. Mayor complejidad inicial. |

---

## 8. Roadmap de migración (fases)

### Fase 0 — Pulir el core (2–3 semanas)
1. ✅ Reemplazar `throw` en `push_rgba` con log + contador de *dropped frames*.
2. ✅ Añadir manejador SIGTERM/SIGINT + graceful shutdown.
3. ✅ Corregir `ordered=TRUE, max-retransmits=0` en el data channel.
4. ✅ Añadir contador de frames dropped y exponer vía `/stats` (JSON) en signaling.
5. ✅ Reducir `MAX_GAME_SERVER_LIFETIME_MS` a 50 min (o refrescar TURN creds).
6. ✅ Migrar el pixel-scaler a `libyuv` (SIMD) o `swscale`.

### Fase 1 — Statefulness out-of-process (3–4 semanas)
1. Añadir Redis como store de `rooms`, `managedRooms`, `rateLimits`, `MAX_CONCURRENT` (distributed).
2. Migrar `romOwnersCache` + `.owners.json` a una tabla Postgres.
3. Subidas de ROM/BIO directas a object storage (presigned URLs) — *browser → S3/GCS/Blob*.
4. Signaling ya no toca el filesystem de ROMs; pasa `s3://...` al game-server.
5. Tests: 2 instancias de signaling, crear room en instancia A → teardown desde B.

### Fase 2 — Desacoplar el Docker socket (4–6 semanas)
1. Elegir orquestador: K8s (Agones) o ECS/EC2-agent.
2. Crear un **game-server operator/agent** que escuche una job queue y spawneea containers.
3. El signaling deja de depender de `/var/run/docker.sock` → publica a la queue.
4. Coturn como DaemonSet (K8s) o agente per-VM.
5. Tests: spawnear 8 game-servers en 2 workers, verificar UDP connectivity + TURN.

### Fase 3 — Multi-región + autoscaling (4–6 semanas)
1. Desplegar control plane en 2 regiones; Postgres read-replica en cada una.
2. Regional game-server pools; `nearest-region` assignment.
3. ASG/Cluster Autoscaler: scale-out en < 30s, scale-to-zero en idle.
4. CDN para web + thumbnails; presigned URLs para ROMs.

### Fase 4 — Calidad de media (4–8 semanas)
1. Adaptive bitrate (TWCC/REM) → reconfigurar `x264enc` en caliente.
2. Audio sync + jitter buffer tuning.
3. Stats WebRTC expuestos al browser (para diagnóstico de jugadores).
4. Opcional: SFU (mediasoup) para 10+ viewers/room.

### Fase 5 — GPU + premium tiers (8+ semanas)
1. Pool de workers GPU (NVENC/AMP); tier "premium" (1080p60).
2. `vaapi`/`cuda` en el GStreamer pipeline.
3. Pricing por minuto + billing usage recording.

---

## 9. Checklist de salud para producción (runbook rápido)

| Verificación | Herramienta | OK esperado |
|---|---|---|
| Game-server CPU < 85% | `docker stats` / Prometheus | ✅ |
| Frames dropped = 0 | `/metrics` (game-server) | ✅ |
| WebRTC connected < 3s | browser stats | ✅ |
| Signaling WS reconnect < 5s | log `reconnect` | ✅ |
| TURN fallback works (symmetric NAT) | test en navegador detrás NAT | ✅ |
| Room idle killed < 5 min | watchdog log | ✅ |
| Postgres lag < 1s | RDS metric | ✅ |
| Redis evicted_keys = 0 | Redis INFO | ✅ |
| Object storage egress < 50% del total | facturación | ✅ |

---

## 10. Prioridades de trabajo (ranking)

| Prioridad | Tarea | Impacto | Esfuerzo |
|---|---|---|---|
| 🔴 Crítica | Graceful shutdown (SIGTERM) | Evita data loss + zombies | 1 día |
| 🔴 Crítica | No-exceptions en callbacks (push_rgba) | Evita crashes de media | 1 día |
| 🔴 Crítica | DataChannel `ordered=TRUE` | Evita input ghosting | 2 horas |
| 🔴 Crítica | Estado en Redis (no in-memory) | Requisito para horizontal scaling | 1 semana |
| 🔴 Crítica | Desacoplar Docker socket | Requisito para cloud | 2–3 semanas |
| 🟠 Alta | TURN creds refresh | Evita media cuts a >1h | 2 días |
| 🟠 Alta | Adaptive bitrate | Calidad/red | 1–2 semanas |
| 🟠 Alta | Object storage para ROMs | Escalabilidad multi-host | 1 semana |
| 🟡 Media | libyuv / SIMD scaler | Reduce CPU 30–50% | 1 semana |
| 🟡 Media | Multi-región + CDN | Reduce latencia/egress | 2–3 semanas |
| 🟢 Baja | GPU NVENC tier | Mejor calidad a menor CPU | 4+ semanas |

---

*Fin del documento.*
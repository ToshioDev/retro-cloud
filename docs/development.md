# Development

## Prerequisites

- Docker Desktop with the daemon running.
- Docker Buildx for cross-platform images (`docker buildx version`).
- A legally obtained NES ROM supplied by the operator.

The host macOS environment does not need CMake or a Libretro core. Both are installed and built inside the Docker image.

## STEP 1/2

```sh
mkdir -p roms
cp /path/to/your/legal/game.nes roms/game.nes
docker compose up --build
```

The container should log the loaded FCEUmm core, its video timing, framebuffer dimensions, and PCM sample count. To run SNES, use `GAME=snes ROM_PATH=/roms/game.sfc`; the image includes Snes9x as a second server-controlled core. The process is headless at this stage; there is no browser endpoint until the WebRTC steps are implemented.

For the first ROM smoke test, set `RUN_FOR_SECONDS=5` and `FRAME_DUMP_PATH=/captures/frame.ppm`, mounting a writable `captures` directory. `FRAME_DUMP_FRAME=120` captures after the boot frames instead of the initial black frame. The host writes the selected framebuffer callback as a PPM image and then exits cleanly. This validates ROM loading, emulation, and framebuffer capture before adding the media pipeline.

To build for both target architectures after enabling Buildx:

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t retro-game-server:step2 ./game-server
```

The NES and SNES cores are compiled from source for the target architecture. Software execution is the baseline and no NVIDIA runtime is required.

## Configuration

The server accepts `GAME`, `ROM_PATH`, `LIBRETRO_CORE`, `VIDEO_WIDTH`, `VIDEO_HEIGHT`, `VIDEO_FPS`, `VIDEO_BITRATE`, `RUN_FOR_SECONDS`, `FRAME_DUMP_PATH`, `FRAME_DUMP_FRAME`, and `VIDEO_OUTPUT_PATH`. `GAME` is restricted to `nes` or `snes`; `ROM_PATH`, `LIBRETRO_CORE`, and output paths are server/operator settings. They are not browser-controlled values.

`VIDEO_OUTPUT_PATH` enables the real GStreamer path. The current software encoder uses `x264enc` with `zerolatency`, no B-frames, and a bounded two-frame queue; VP8/WebM is the fallback when x264 is unavailable.

Set `WEBRTC_DEBUG=1` to start the native `webrtcbin` video peer. The game-server sends a real SDP offer and trickle ICE candidates using H.264/I420 through `/signaling`; Chrome reaches `WebRTC connected` and receives the 256x224 SNES track. Stable server-side DataChannel negotiation is still pending, so the browser currently reports `Input: Not connected` until that slice is completed.

## Troubleshooting

- `cannot open ROM_PATH`: mount a ROM at `/roms/game.nes` or set `ROM_PATH` to a path inside the mounted volume.
- `missing Libretro symbol`: the core is incompatible with the Libretro host ABI or the wrong shared library was configured.
- Docker cannot connect to `/var/run/docker.sock`: start Docker Desktop before running Compose.
- Buildx cross-build fails: build each architecture separately first; a native software core build must pass before publishing a multi-platform manifest.

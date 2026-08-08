# Retro Cloud

Experimental server-side retro cloud gaming pipeline inspired by Piepacker/Jam.gg. The emulator runs inside Docker; the browser will receive media through WebRTC and send controls through a WebRTC DataChannel in later steps.

## Current status

STEP 1 and STEP 2 are implemented:

- Ubuntu-based multi-stage Docker build.
- C++ Libretro host with a stable emulator boundary.
- NES and SNES cores built from `libretro-fceumm` and `Snes9x` during the image build.
- Real Libretro framebuffer and PCM callbacks.
- No ROMs are included. The operator must provide a legally obtained ROM.

The current container is intentionally headless and logs framebuffer/audio metrics. GStreamer, WebRTC, signaling, and the React client are the next implementation steps.

## Run

Place a legally obtained NES ROM at `roms/game.nes`, then run:

```sh
mkdir -p roms
# Copy your own ROM to roms/game.nes
docker compose up --build
```

The same image can run independently:

```sh
docker build -t retro-game-server ./game-server
docker run --rm -it -v "$PWD/roms:/roms:ro" retro-game-server
```

Useful environment variables include `ROM_PATH`, `VIDEO_FPS`, `VIDEO_WIDTH`, `VIDEO_HEIGHT`, and `VIDEO_BITRATE`. The core path is server-controlled through `LIBRETRO_CORE`; it is not exposed to browser input.

For a bounded first-ROM check, mount an output directory and dump the first real framebuffer as a PPM image:

```sh
mkdir -p captures
docker run --rm \
	-v "$PWD/roms:/roms:ro" \
	-v "$PWD/captures:/captures" \
	-e RUN_FOR_SECONDS=5 \
	-e FRAME_DUMP_FRAME=120 \
	-e FRAME_DUMP_PATH=/captures/first-frame.ppm \
	retro-game-server
```

The process must log the selected core, framebuffer dimensions, audio sample count, and `test run complete`. The generated PPM is a direct capture from the emulator callback, not a prerecorded video.

To validate the GStreamer video stage, write a real software-encoded H.264 stream:

```sh
mkdir -p captures
docker compose run --rm \
	-e GAME=snes \
	-e ROM_PATH=/roms/bomberman5.sfc \
	-e RUN_FOR_SECONDS=5 \
	-e VIDEO_OUTPUT_PATH=/captures/bomberman5.h264 \
	-v "$PWD/captures:/captures" \
	game-server
```

This is an intermediate pipeline check. WebRTC will be the browser transport in the next step.

SNES is also supported by setting `GAME=snes` and providing a legally obtained ROM at `roms/game.sfc`:

```sh
GAME=snes ROM_PATH=/roms/game.sfc docker compose up --build
```

Only `GAME=nes` and `GAME=snes` are accepted. The browser cannot select a core or execute a path.

## Roadmap

1. Docker and emulator bring-up.
2. Framebuffer capture.
3. Local test rendering.
4. GStreamer pipeline.
5. WebRTC video.
6. Browser video receiver.
7. WebRTC DataChannel.
8. Keyboard and Gamepad input.
9. Audio and synchronization.
10. STUN, TURN, and Coolify deployment documentation.

See [docs/architecture.md](docs/architecture.md) for component boundaries and media/input flows.

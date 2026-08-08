# Retro Cloud Architecture

## Scope

The MVP runs a server-selected Libretro NES or SNES core inside the `game-server` container. The browser is a WebRTC receiver and input sender; it never loads or executes the emulator core.

## Components

- `game-server`: C++ runtime. It owns the emulator lifecycle, frame loop, input state, and future video/audio/WebRTC adapters.
- `signaling`: Small Node.js/TypeScript WebSocket service for SDP and ICE message exchange.
- `web`: React/Vite client. It renders remote media and sends keyboard/gamepad events through a WebRTC DataChannel.
- `roms`: User-provided, legally obtained ROMs mounted into the game-server container. No ROM is bundled.

The emulator boundary is represented by an `Emulator` interface. The first implementation is a dynamic Libretro host that loads one of two server-controlled shared libraries: FCEUmm for NES or Snes9x for SNES. Video, audio, input, and transport code consume that interface rather than depending on a concrete core.

## Video flow

```text
Libretro video_refresh callback
  -> RGBA/RGB framebuffer owned by game-server
  -> pixel conversion/scaler
  -> GStreamer appsrc
  -> low-latency software H.264 or VP8 encoder
  -> RTP payload
  -> webrtcbin video track
  -> browser HTMLVideoElement
```

The initial STEP 1/2 host verified the real framebuffer callback. The current host also feeds GStreamer with a low-latency software encoder; `webrtcbin` remains the next transport adapter so emulator bring-up stays independently testable.

## Audio flow

```text
Libretro audio_sample_batch callback
  -> PCM ring buffer with video-frame timestamps
  -> GStreamer appsrc
  -> Opus encoder
  -> webrtcbin audio track
  -> browser audio output
```

Audio and video timestamps originate from the same emulation clock. The audio ring buffer is bounded so backpressure cannot silently add seconds of latency.

## Input flow

```text
Keyboard/Gamepad API
  -> browser InputMapper
  -> ordered JSON messages on WebRTC DataChannel
  -> game-server input queue
  -> Libretro retro_input_state callback
  -> emulator core
```

The wire format includes `player`, `button`, `pressed`, and a client timestamp. The server validates button names and session ownership; it never accepts commands, paths, or arbitrary core names from the browser.

## WebRTC flow

1. The browser joins a session through signaling.
2. The browser creates an SDP offer and a DataChannel.
3. The game-server creates the answering peer connection and media tracks.
4. Offer, answer, and trickle ICE candidates travel through the signaling WebSocket.
5. STUN is configured through environment variables. TURN is reserved for the later deployment step.
6. The browser is receive-only for media and sender-only for game input.

The transport adapter is separate from the emulator host, allowing a future native WebRTC implementation or GStreamer `webrtcbin` integration without changing the Libretro boundary.

## Signaling flow

`POST /health` returns service health. `WS /signaling` forwards typed `join`, `offer`, `answer`, `candidate`, and `leave` messages to peers in a session. Signaling does not carry video, audio, ROM data, or input polling traffic.

## Emulator lifecycle

The host selects `nes` or `snes`, loads the corresponding core shared object from a server-controlled path, sets the Libretro callbacks, loads the user-mounted ROM, and runs `retro_run()` at the configured frame rate. Input is exposed through the Libretro callback. Shutdown unloads the ROM and core cleanly.

The ROM path is an operator configuration (`ROM_PATH`), not a browser parameter. A missing ROM or core is a startup error with an actionable log message.

## Docker topology

`docker compose up --build` starts three services on one local network:

- `game-server`: C++ runtime, `/roms` mounted read-only.
- `signaling`: WebSocket signaling endpoint.
- `web`: Vite development server, configured with the signaling URL.

The game-server image uses Ubuntu and installs build/runtime dependencies without requiring NVIDIA or a GPU. The Dockerfile is prepared for `linux/amd64` and `linux/arm64`; software encoding is the portable baseline.

## Replaceable parts

- Libretro core: any compatible NES core implementing the Libretro API.
- Emulator host: another Libretro frontend can replace the C++ host while preserving transport contracts.
- Video encoder: software x264/VP8 first, then VA-API or other host-specific encoders behind the GStreamer pipeline.
- WebRTC transport: GStreamer `webrtcbin` or a native WebRTC adapter.
- Signaling: the minimal WebSocket service can later be replaced without changing media or input formats.

## Architecture-dependent parts

The Libretro API and software frame loop are architecture-neutral. The core `.so` and compiler must match the target architecture. AMD64 commonly has more encoder packages available; ARM64 must retain a software fallback and should be verified during Buildx builds. Hardware encoding is intentionally optional and must not be required for startup.

## Current implementation boundary

STEP 1 provides Docker, Ubuntu, CMake, Libretro headers, and a multi-stage build. STEP 2 provides a real dynamic Libretro host and NES/SNES core build paths, including framebuffer and audio callback metrics. The GStreamer framebuffer-to-H.264 path, signaling relay, native `webrtcbin` offer/ICE producer, and end-to-end browser video test are implemented. Chrome reaches `WebRTC connected` and receives the real emulator track. Stable server-side DataChannel negotiation, remote input application, audio track, and input end-to-end test remain next.

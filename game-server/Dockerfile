FROM ubuntu:24.04 AS core-builder

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth=1 https://github.com/libretro/libretro-fceumm.git fceumm
RUN make -C /src/fceumm -f Makefile.libretro platform=unix -j"$(nproc)"
RUN git clone --depth=1 https://github.com/libretro/Snes9x.git snes9x
RUN make -C /src/snes9x/libretro platform=unix -j"$(nproc)"

FROM ubuntu:24.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates cmake make g++ pkg-config \
    libwebsockets-dev nlohmann-json3-dev \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    libgstreamer-plugins-bad1.0-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY CMakeLists.txt .
COPY src ./src
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --parallel

FROM ubuntu:24.04 AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 \
    libwebsockets19t64 \
    gstreamer1.0-tools gstreamer1.0-nice gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /roms /opt/libretro/cores
COPY --from=build /src/build/game-server /usr/local/bin/game-server
COPY --from=core-builder /src/fceumm/fceumm_libretro.so /opt/libretro/cores/fceumm_libretro.so
COPY --from=core-builder /src/snes9x/libretro/snes9x_libretro.so /opt/libretro/cores/snes9x_libretro.so
ENV GAME=nes \
    ROM_PATH=/roms/game.nes \
    VIDEO_WIDTH=640 \
    VIDEO_HEIGHT=480 \
    VIDEO_FPS=60 \
    VIDEO_BITRATE=2M
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/game-server"]

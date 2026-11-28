cmake_minimum_required(VERSION 3.20)
project(retro_game_server LANGUAGES CXX)

find_package(PkgConfig REQUIRED)
pkg_check_modules(GSTREAMER REQUIRED IMPORTED_TARGET
    gstreamer-1.0
    gstreamer-app-1.0
    gstreamer-video-1.0
    gstreamer-webrtc-1.0
    gstreamer-sdp-1.0
)
pkg_check_modules(LWS REQUIRED IMPORTED_TARGET libwebsockets)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(game-server
    src/main.cpp
    src/video/gstreamer_pipeline.cpp
    src/video/webrtc_pipeline.cpp
    src/webrtc/signaling_client.cpp
)

target_include_directories(game-server PRIVATE src)
target_link_libraries(game-server PRIVATE dl PkgConfig::GSTREAMER PkgConfig::LWS)

if (UNIX)
    target_compile_options(game-server PRIVATE -Wall -Wextra -Wpedantic)
endif()

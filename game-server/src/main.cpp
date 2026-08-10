#include "emulator/libretro.h"
#include "video/gstreamer_pipeline.h"
#include "video/webrtc_pipeline.h"
#include "webrtc/signaling_client.h"
#include <gst/gst.h>

#include <nlohmann/json.hpp>

#include <dlfcn.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using json = nlohmann::json;

namespace {

constexpr unsigned kMaxPlayers = 4;
std::atomic<bool> button_state[kMaxPlayers][16] = {};

int button_id(const std::string &button) {
    if (button == "B") return RETRO_DEVICE_ID_JOYPAD_B;
    if (button == "A") return RETRO_DEVICE_ID_JOYPAD_A;
    if (button == "X") return RETRO_DEVICE_ID_JOYPAD_X;
    if (button == "Y") return RETRO_DEVICE_ID_JOYPAD_Y;
    if (button == "SELECT") return RETRO_DEVICE_ID_JOYPAD_SELECT;
    if (button == "START") return RETRO_DEVICE_ID_JOYPAD_START;
    if (button == "UP") return RETRO_DEVICE_ID_JOYPAD_UP;
    if (button == "DOWN") return RETRO_DEVICE_ID_JOYPAD_DOWN;
    if (button == "LEFT") return RETRO_DEVICE_ID_JOYPAD_LEFT;
    if (button == "RIGHT") return RETRO_DEVICE_ID_JOYPAD_RIGHT;
    if (button == "L") return RETRO_DEVICE_ID_JOYPAD_L;
    if (button == "R") return RETRO_DEVICE_ID_JOYPAD_R;
    if (button == "L2") return RETRO_DEVICE_ID_JOYPAD_L2;
    if (button == "R2") return RETRO_DEVICE_ID_JOYPAD_R2;
    return -1;
}

struct Runtime {
    void *library = nullptr;
    retro_system_av_info av{};
    std::vector<std::uint8_t> framebuffer;
    std::vector<std::uint8_t> framebuffer_scaled;
    std::uint64_t frames = 0;
    std::uint64_t audio_samples = 0;
    unsigned width = 0;
    unsigned height = 0;
    // Fixed for the whole session once the first frame arrives: some cores (PS1's pcsx_rearmed, notably)
    // change their per-frame width/height at runtime as games switch video modes, but the GStreamer/WebRTC
    // appsrc caps are negotiated once. Every frame gets letterboxed into this canvas so the buffer size
    // pushed downstream always matches what was negotiated, instead of silently corrupting/dropping frames.
    unsigned canvas_width = 0;
    unsigned canvas_height = 0;
    bool canvas_ready = false;
    unsigned canvas_warmup_frames = 0;
    std::map<std::pair<unsigned, unsigned>, unsigned> canvas_votes;
    std::string game_id = "nes";
    unsigned pixel_format = RETRO_PIXEL_FORMAT_XRGB8888;
    std::string system_directory;
    std::string save_directory;
    std::unique_ptr<GStreamerPipeline> video_pipeline;
    std::unique_ptr<WebRtcPipeline> webrtc_pipeline;
    std::unique_ptr<SignalingClient> signaling_client;
    bool webrtc_debug = false;
    std::string signaling_url;
    std::string signaling_room;
    std::string video_output_path;
    unsigned video_bitrate_kbps = 2000;
    bool low_bandwidth = false;
    std::string own_peer_id;
    std::mutex peer_actions_mutex;
    std::vector<std::function<void()>> pending_peer_actions;
} runtime;

void queue_peer_action(std::function<void()> action) {
    std::lock_guard<std::mutex> lock(runtime.peer_actions_mutex);
    runtime.pending_peer_actions.push_back(std::move(action));
}

void log_line(const char *tag, const std::string &message) {
    std::cout << tag << " " << message << std::endl;
}

void core_log(int level, const char *format, ...) {
    const char *name = level >= RETRO_LOG_ERROR ? "ERROR" : level == RETRO_LOG_WARN ? "WARN" : "INFO";
    std::cout << "[EMULATOR] [CORE " << name << "] " << format << std::endl;
}

bool environment(unsigned command, void *data) {
    switch (command) {
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
        const auto format = *static_cast<unsigned *>(data);
        if (format > RETRO_PIXEL_FORMAT_RGB565) {
            log_line("[EMULATOR]", "core selected an unsupported pixel format");
            return false;
        }
        runtime.pixel_format = format;
        return true;
    }
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
        static_cast<retro_log_callback *>(data)->log = core_log;
        return true;
    case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
        return false;
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
        runtime.av = *static_cast<retro_system_av_info *>(data);
        return true;
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
        if (runtime.system_directory.empty()) return false;
        *static_cast<const char **>(data) = runtime.system_directory.c_str();
        return true;
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        if (runtime.save_directory.empty()) return false;
        *static_cast<const char **>(data) = runtime.save_directory.c_str();
        return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE:
        return false; // no overrides; cores fall back to their built-in defaults
    case RETRO_ENVIRONMENT_SET_VARIABLES:
        return true; // acknowledge, we don't expose core options
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
        return false; // stick to the legacy variables API
    default:
        return false;
    }
}

void video_refresh(const void *data, unsigned width, unsigned height, std::size_t pitch) {
    if (!data || width == 0 || height == 0) return;
    if (runtime.webrtc_pipeline && runtime.webrtc_pipeline->active()) {
        std::vector<std::function<void()>> actions;
        {
            std::lock_guard<std::mutex> lock(runtime.peer_actions_mutex);
            actions.swap(runtime.pending_peer_actions);
        }
        for (auto &action : actions) action();
    }
    runtime.width = width;
    runtime.height = height;
    if (!runtime.canvas_ready) {
        // Neither the first frame nor geometry.base_width/height nor "biggest frame seen" reliably predicts
        // what a game actually renders gameplay at: PS1 boot sequences commonly flash a one-off frame at a
        // different (sometimes much larger, sometimes much smaller) size than the steady picture that
        // follows — a BIOS init frame, a letterboxed publisher logo, etc. Picking the single biggest frame
        // seen (the previous approach) let one such outlier lock in a canvas far bigger than the real
        // content, rendering everything after it tiny in a corner.
        // Instead: watch ~0.5s of frames and go with whichever resolution shows up most — enough for the
        // emulator to settle on its real render resolution while keeping startup snappy.
        runtime.canvas_votes[{width, height}] += 1;
        constexpr unsigned kCanvasWarmupFrames = 30;
        if (++runtime.canvas_warmup_frames < kCanvasWarmupFrames) return;
        unsigned best_votes = 0;
        for (const auto &[size, votes] : runtime.canvas_votes) {
            if (votes > best_votes) {
                best_votes = votes;
                runtime.canvas_width = size.first;
                runtime.canvas_height = size.second;
            }
        }
        runtime.canvas_votes.clear();
        runtime.canvas_ready = true;
    }
    const auto canvas_width = runtime.canvas_width;
    const auto canvas_height = runtime.canvas_height;
    // Defensive clamp: a core that under-reports geometry.max_width/max_height and later exceeds it would
    // otherwise write past the canvas — clip to what the negotiated caps actually declared.
    const auto draw_width = std::min(width, canvas_width);
    runtime.framebuffer.assign(static_cast<std::size_t>(canvas_width) * canvas_height * 4, 0);
    for (unsigned row = 0; row < height && row < canvas_height; ++row) {
        const auto *source = static_cast<const std::uint8_t *>(data) + static_cast<std::size_t>(row) * pitch;
        auto *target = runtime.framebuffer.data() + static_cast<std::size_t>(row) * canvas_width * 4;
        if (runtime.pixel_format == RETRO_PIXEL_FORMAT_XRGB8888) {
            for (unsigned column = 0; column < draw_width; ++column) {
                target[column * 4] = source[column * 4 + 2];
                target[column * 4 + 1] = source[column * 4 + 1];
                target[column * 4 + 2] = source[column * 4];
                target[column * 4 + 3] = 255;
            }
            continue;
        }
        for (unsigned column = 0; column < draw_width; ++column) {
            const auto value = static_cast<std::uint16_t>(source[column * 2]) |
                               (static_cast<std::uint16_t>(source[column * 2 + 1]) << 8);
            if (runtime.pixel_format == RETRO_PIXEL_FORMAT_RGB565) {
                target[column * 4] = static_cast<std::uint8_t>(((value >> 11) & 0x1f) * 255 / 31);
                target[column * 4 + 1] = static_cast<std::uint8_t>(((value >> 5) & 0x3f) * 255 / 63);
                target[column * 4 + 2] = static_cast<std::uint8_t>((value & 0x1f) * 255 / 31);
            } else {
                target[column * 4] = static_cast<std::uint8_t>(((value >> 10) & 0x1f) * 255 / 31);
                target[column * 4 + 1] = static_cast<std::uint8_t>(((value >> 5) & 0x1f) * 255 / 31);
                target[column * 4 + 2] = static_cast<std::uint8_t>((value & 0x1f) * 255 / 31);
            }
            target[column * 4 + 3] = 255;
        }
    }
    // Retro framebuffers (NES ~256x240, SNES ~256x224, PS1 ~320x240) are tiny by modern display standards.
    // Streaming them at native size and letting the browser stretch a handful of source pixels across a
    // widescreen monitor looks soft even with pixelated rendering. Nearest-neighbor upscaling here instead
    // means the encoder is actually working with — and the client actually receives — more real pixels,
    // while staying perfectly crisp (each source pixel becomes a clean block, never blurred/interpolated).
    // Skipped for PS1 (its CPU-bound 3D emulation is already the heaviest thing running in this container,
    // shared with x264enc, itself CPU-only — no GPU passthrough on this host) and skipped whenever the
    // room was created in low-bandwidth mode: fewer encoded pixels at the same bitrate means less
    // compression artifacting for a viewer on a slow connection. The browser's CSS scaling still fills the
    // screen either way, just softer.
    const unsigned kUpscaleFactor = (runtime.game_id == "ps1" || runtime.low_bandwidth) ? 1 : 2;
    const auto scaled_width = canvas_width * kUpscaleFactor;
    const auto scaled_height = canvas_height * kUpscaleFactor;
    runtime.framebuffer_scaled.resize(static_cast<std::size_t>(scaled_width) * scaled_height * 4);
    for (unsigned row = 0; row < scaled_height; ++row) {
        const auto *source_row = runtime.framebuffer.data() + static_cast<std::size_t>(row / kUpscaleFactor) * canvas_width * 4;
        auto *target_row = runtime.framebuffer_scaled.data() + static_cast<std::size_t>(row) * scaled_width * 4;
        for (unsigned column = 0; column < scaled_width; ++column) {
            std::memcpy(target_row + column * 4, source_row + (column / kUpscaleFactor) * 4, 4);
        }
    }
    if (!runtime.video_output_path.empty()) {
        if (!runtime.video_pipeline) runtime.video_pipeline = std::make_unique<GStreamerPipeline>();
        if (!runtime.video_pipeline->active()) {
            runtime.video_pipeline->start(scaled_width, scaled_height, runtime.av.timing.fps > 1.0 ? runtime.av.timing.fps : 60.0,
                                          runtime.video_output_path, runtime.video_bitrate_kbps);
        }
        runtime.video_pipeline->push_rgba(runtime.framebuffer_scaled.data(), runtime.framebuffer_scaled.size(), runtime.frames);
    }
    if (runtime.signaling_client) {
        if (!runtime.webrtc_pipeline) runtime.webrtc_pipeline = std::make_unique<WebRtcPipeline>();
        if (!runtime.webrtc_pipeline->active()) {
            const unsigned sample_rate = runtime.av.timing.sample_rate > 1.0
                ? static_cast<unsigned>(runtime.av.timing.sample_rate) : 48000;
            runtime.webrtc_pipeline->start(scaled_width, scaled_height, runtime.av.timing.fps > 1.0 ? runtime.av.timing.fps : 60.0,
                                           runtime.video_bitrate_kbps, sample_rate, runtime.signaling_client.get(), runtime.signaling_room,
                                           [](unsigned player_number, std::uint16_t mask) {
                                               if (player_number == 0 || player_number > kMaxPlayers) return;
                                               for (unsigned id = 0; id < 16; ++id)
                                                   button_state[player_number - 1][id] = (mask & (1u << id)) != 0;
                                           });
        }
        runtime.webrtc_pipeline->push_rgba(runtime.framebuffer_scaled.data(), runtime.framebuffer_scaled.size(), runtime.frames);
    }
    ++runtime.frames;
}

std::size_t audio_batch(const int16_t *data, std::size_t frames) {
    runtime.audio_samples += frames;
    if (runtime.webrtc_pipeline && runtime.webrtc_pipeline->active()) {
        runtime.webrtc_pipeline->push_pcm(data, frames);
    }
    return frames;
}

void audio_sample(int16_t, int16_t) { ++runtime.audio_samples; }
void input_poll() {}

int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
    if (port >= kMaxPlayers || device != RETRO_DEVICE_JOYPAD || index != 0 || id >= 16) return 0;
    return button_state[port][id].load() ? 1 : 0;
}

template <typename T> T symbol(const char *name) {
    auto value = reinterpret_cast<T>(dlsym(runtime.library, name));
    if (!value) throw std::runtime_error(std::string("missing Libretro symbol: ") + name);
    return value;
}

std::string env_or(const char *name, const char *fallback) {
    const char *value = std::getenv(name);
    return value && *value ? value : fallback;
}

std::string random_room_id() {
    static constexpr char alphabet[] = "abcdefghijklmnopqrstuvwxyz0123456789";
    std::random_device seed;
    std::mt19937 rng(seed());
    std::uniform_int_distribution<std::size_t> pick(0, sizeof(alphabet) - 2);
    std::string id(6, '\0');
    for (auto &character : id) character = alphabet[pick(rng)];
    return id;
}

unsigned bitrate_kbps(const std::string &value) {
    if (value.empty()) return 2000;
    const auto suffix = value.back();
    const auto number = std::stoul((suffix == 'M' || suffix == 'K') ? value.substr(0, value.size() - 1) : value);
    return suffix == 'M' ? static_cast<unsigned>(number * 1000) : static_cast<unsigned>(suffix == 'K' ? number : number / 1000);
}

std::vector<std::uint8_t> read_rom(const std::string &path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file) throw std::runtime_error("cannot open ROM_PATH: " + path);
    const auto size = file.tellg();
    if (size <= 0) throw std::runtime_error("ROM_PATH is empty: " + path);
    std::vector<std::uint8_t> rom(static_cast<std::size_t>(size));
    file.seekg(0);
    file.read(reinterpret_cast<char *>(rom.data()), size);
    return rom;
}

void write_ppm(const std::string &path) {
    std::ofstream file(path, std::ios::binary);
    if (!file) throw std::runtime_error("cannot write FRAME_DUMP_PATH: " + path);
    file << "P6\n" << runtime.width << " " << runtime.height << "\n255\n";
    for (unsigned row = 0; row < runtime.height; ++row) {
        for (unsigned column = 0; column < runtime.width; ++column) {
            const auto *pixel = runtime.framebuffer.data() + (static_cast<std::size_t>(row) * runtime.width + column) * 4;
            const char rgb[] = {static_cast<char>(pixel[2]), static_cast<char>(pixel[1]), static_cast<char>(pixel[0])};
            file.write(rgb, sizeof(rgb));
        }
    }
}

struct GameConfig {
    std::string name;
    std::string core_path;
    std::string rom_path;
};

GameConfig game_config() {
    const std::string game = env_or("GAME", "nes");
    if (game == "nes") {
        return {"NES", env_or("LIBRETRO_CORE", "/opt/libretro/cores/fceumm_libretro.so"), env_or("ROM_PATH", "/roms/game.nes")};
    }
    if (game == "snes") {
        return {"SNES", env_or("LIBRETRO_CORE", "/opt/libretro/cores/snes9x_libretro.so"), env_or("ROM_PATH", "/roms/game.sfc")};
    }
    if (game == "ps1") {
        return {"PS1", env_or("LIBRETRO_CORE", "/opt/libretro/cores/pcsx_rearmed_libretro.so"), env_or("ROM_PATH", "/roms/game.bin")};
    }
    throw std::runtime_error("unsupported GAME='" + game + "'; allowed values are nes, snes, or ps1");
}

} // namespace

int main() {
    try {
        runtime.game_id = env_or("GAME", "nes");
        const auto config = game_config();
        const unsigned requested_fps = static_cast<unsigned>(std::stoul(env_or("VIDEO_FPS", "60")));
        const unsigned run_for_seconds = static_cast<unsigned>(std::stoul(env_or("RUN_FOR_SECONDS", "0")));
        const std::uint64_t frame_dump_frame = static_cast<std::uint64_t>(std::stoull(env_or("FRAME_DUMP_FRAME", "1")));
        const std::string frame_dump_path = env_or("FRAME_DUMP_PATH", "");
        runtime.video_output_path = env_or("VIDEO_OUTPUT_PATH", "");
        // 1.5Mbps default: retro pixel-art content (flat colors, small motion deltas) encodes far more
        // efficiently than camera/screen-share video, so this still looks clean while leaving headroom
        // for viewers well under 20Mbps. The room host can pick a lower explicit tier at creation time
        // (signaling passes VIDEO_BITRATE/LOW_BANDWIDTH through) for known-bad connections.
        runtime.video_bitrate_kbps = bitrate_kbps(env_or("VIDEO_BITRATE", "1500K"));
        runtime.low_bandwidth = env_or("LOW_BANDWIDTH", "0") == "1";
        runtime.webrtc_debug = env_or("WEBRTC_DEBUG", "0") == "1";
        runtime.signaling_url = env_or("SIGNALING_URL", "ws://signaling:8080/signaling");
        runtime.system_directory = env_or("SYSTEM_DIRECTORY", "/system");
        runtime.save_directory = env_or("SAVE_DIRECTORY", "/system/saves");
        const char *fixed_room = std::getenv("SIGNALING_ROOM");
        runtime.signaling_room = fixed_room && *fixed_room ? fixed_room : random_room_id();
        log_line("[EMULATOR]", "session room: " + runtime.signaling_room);
        gst_init(nullptr, nullptr);

        {
            log_line("[WEBRTC]", "connecting to signaling at " + runtime.signaling_url + " room=" + runtime.signaling_room);
            runtime.signaling_client = std::make_unique<SignalingClient>();
            runtime.signaling_client->connect(runtime.signaling_url, runtime.signaling_room,
                [](const std::string &type, const std::string &payload, const std::string &from) {
                    if (type == "join") {
                        const auto message = json::parse(payload, nullptr, false);
                        if (message.is_discarded()) return;
                        const auto peer_id = message.value("peerId", std::string());
                        const auto role = message.value("role", std::string());
                        if (role == "host") {
                            if (runtime.own_peer_id.empty()) {
                                runtime.own_peer_id = peer_id;
                                log_line("[WEBRTC]", "registered as host peer=" + peer_id + " room=" + runtime.signaling_room);
                            }
                            return;
                        }
                        const auto player_number = message.value("playerNumber", 0u);
                        if (peer_id.empty() || player_number == 0) return;
                        log_line("[WEBRTC]", "player joined room=" + runtime.signaling_room + " peer=" + peer_id +
                                              " player=" + std::to_string(player_number));
                        queue_peer_action([peer_id, player_number]() {
                            if (runtime.webrtc_pipeline) runtime.webrtc_pipeline->add_peer(peer_id, player_number);
                        });
                        return;
                    }
                    if (type == "leave") {
                        const auto message = json::parse(payload, nullptr, false);
                        const auto peer_id = !message.is_discarded() ? message.value("peerId", std::string()) : std::string();
                        if (peer_id.empty()) return;
                        log_line("[WEBRTC]", "player left peer=" + peer_id);
                        queue_peer_action([peer_id]() {
                            if (runtime.webrtc_pipeline) runtime.webrtc_pipeline->remove_peer(peer_id);
                        });
                        return;
                    }
                    if ((type == "answer" || type == "candidate") && !from.empty()) {
                        queue_peer_action([from, type, payload]() {
                            if (runtime.webrtc_pipeline) runtime.webrtc_pipeline->handle_signaling(from, type, payload);
                        });
                    }
                });
        }

        log_line("[EMULATOR]", "loading " + config.name + " core " + config.core_path);
        runtime.library = dlopen(config.core_path.c_str(), RTLD_NOW | RTLD_LOCAL);
        if (!runtime.library) throw std::runtime_error(dlerror());

        const auto set_environment = symbol<retro_set_environment_t>("retro_set_environment");
        const auto set_video = symbol<retro_set_video_refresh_t>("retro_set_video_refresh");
        const auto set_audio = symbol<retro_set_audio_sample_t>("retro_set_audio_sample");
        const auto set_audio_batch = symbol<retro_set_audio_sample_batch_t>("retro_set_audio_sample_batch");
        const auto set_input_poll = symbol<retro_set_input_poll_t>("retro_set_input_poll");
        const auto set_input_state = symbol<retro_set_input_state_t>("retro_set_input_state");
        const auto init = symbol<retro_init_t>("retro_init");
        const auto get_info = symbol<retro_get_system_info_t>("retro_get_system_info");
        const auto get_av_info = symbol<retro_get_system_av_info_t>("retro_get_system_av_info");
        const auto load_game = symbol<retro_load_game_t>("retro_load_game");
        const auto unload_game = symbol<retro_unload_game_t>("retro_unload_game");
        const auto deinit = symbol<retro_deinit_t>("retro_deinit");
        const auto run = symbol<retro_run_t>("retro_run");

        set_environment(environment);
        set_video(video_refresh);
        set_audio(audio_sample);
        set_audio_batch(audio_batch);
        set_input_poll(input_poll);
        set_input_state(input_state);
        init();

        retro_system_info info{};
        get_info(&info);
        log_line("[EMULATOR]", std::string("core: ") + (info.library_name ? info.library_name : "unknown") + " " + (info.library_version ? info.library_version : ""));

        auto rom = read_rom(config.rom_path);
        retro_game_info game{config.rom_path.c_str(), rom.data(), rom.size(), nullptr};
        if (!load_game(&game)) throw std::runtime_error("Libretro core rejected ROM_PATH");
        get_av_info(&runtime.av);

        const double fps = runtime.av.timing.fps > 1.0 ? runtime.av.timing.fps : requested_fps;
        log_line("[EMULATOR]", "running " + config.name + " at " + std::to_string(fps) + " FPS");
        log_line("[VIDEO]", "capturing Libretro framebuffer as normalized RGBA");
        log_line("[AUDIO]", "capturing Libretro PCM samples");

        const auto frame_duration = std::chrono::duration<double>(1.0 / fps);
        auto next_frame = std::chrono::steady_clock::now();
        const auto stop_at = run_for_seconds > 0
            ? next_frame + std::chrono::seconds(run_for_seconds)
            : std::chrono::steady_clock::time_point::max();
        bool frame_dumped = false;
        while (std::chrono::steady_clock::now() < stop_at) {
            if (runtime.signaling_client) runtime.signaling_client->poll();
            run();
            if (!frame_dumped && !frame_dump_path.empty() && runtime.frames >= frame_dump_frame) {
                write_ppm(frame_dump_path);
                log_line("[VIDEO]", "wrote framebuffer to " + frame_dump_path);
                frame_dumped = true;
            }
            next_frame += std::chrono::duration_cast<std::chrono::steady_clock::duration>(frame_duration);
            // If emulation + encoding overran the frame budget (this container has a hard NanoCpus quota
            // and shares it with x264), next_frame is already in the past. Without a resync the loop then
            // runs flat out trying to repay a debt it can never clear, and every extra frame it pushes
            // just queues up ahead of the player's next input. Drop the missed frames instead: skipping
            // a frame is invisible, running a second behind is not.
            const auto now = std::chrono::steady_clock::now();
            if (next_frame < now) next_frame = now;
            std::this_thread::sleep_until(next_frame);
            if (runtime.frames > 0 && runtime.frames % static_cast<std::uint64_t>(fps) == 0) {
                log_line("[VIDEO]", "frames=" + std::to_string(runtime.frames) + " size=" + std::to_string(runtime.width) + "x" + std::to_string(runtime.height));
                log_line("[AUDIO]", "samples=" + std::to_string(runtime.audio_samples));
            }
        }

        if (run_for_seconds > 0) log_line("[EMULATOR]", "test run complete");

        unload_game();
        deinit();
        if (runtime.video_pipeline) runtime.video_pipeline->stop();
        if (runtime.webrtc_pipeline) runtime.webrtc_pipeline->stop();
        if (runtime.signaling_client) runtime.signaling_client->close();
        dlclose(runtime.library);
    } catch (const std::exception &error) {
        std::cerr << "[EMULATOR] fatal: " << error.what() << std::endl;
        if (runtime.library) dlclose(runtime.library);
        return EXIT_FAILURE;
    }
}

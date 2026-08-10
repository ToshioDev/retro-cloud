#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>

class SignalingClient;

struct _GstElement;
using GstElement = _GstElement;
struct _GObject;
using GObject = _GObject;
struct _GBytes;
using GBytes = _GBytes;

class WebRtcPipeline {
public:
    struct Peer;

    // (player_number, button_mask). player_number == 0 for unrecognized/host messages.
    // button_mask is a 16-bit bitmask of currently held buttons (bit N = libretro RETRO_DEVICE_ID_JOYPAD_N).
    using InputHandler = std::function<void(unsigned player_number, std::uint16_t button_mask)>;

    WebRtcPipeline();
    ~WebRtcPipeline();

    WebRtcPipeline(const WebRtcPipeline &) = delete;
    WebRtcPipeline &operator=(const WebRtcPipeline &) = delete;

    void start(unsigned width, unsigned height, double fps, unsigned bitrate_kbps, unsigned sample_rate,
               SignalingClient *signaling, std::string room, InputHandler input_handler);
    void push_rgba(const std::uint8_t *data, std::size_t size, std::uint64_t frame_number);
    void push_pcm(const std::int16_t *data, std::size_t frames);

    // Adds a new WebRTC receiver for a just-joined peer and starts negotiating with it.
    void add_peer(const std::string &peer_id, unsigned player_number);
    void remove_peer(const std::string &peer_id);
    void handle_signaling(const std::string &peer_id, const std::string &type, const std::string &payload);

    SignalingClient *signaling_client() const { return signaling_; }
    const std::string &room() const { return room_; }
    const InputHandler &input_handler() const { return input_handler_; }
    void stop();
    bool active() const;

private:
    void remove_peer_elements(Peer &peer);

    GstElement *pipeline_ = nullptr;
    GstElement *source_ = nullptr;
    GstElement *audio_source_ = nullptr;
    GstElement *video_tee_ = nullptr;
    GstElement *audio_tee_ = nullptr;
    std::uint64_t frame_duration_ns_ = 0;
    unsigned sample_rate_ = 48000;
    SignalingClient *signaling_ = nullptr;
    std::string room_;
    InputHandler input_handler_;
    std::map<std::string, std::unique_ptr<Peer>> peers_;
};

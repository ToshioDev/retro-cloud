#include "webrtc_pipeline.h"
#include "webrtc/signaling_client.h"

#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#include <gst/sdp/sdp.h>
#include <gst/webrtc/webrtc.h>
#include <nlohmann/json.hpp>

#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>

using json = nlohmann::json;

struct WebRtcPipeline::Peer {
    WebRtcPipeline *pipeline = nullptr;
    std::string peer_id;
    unsigned player_number = 0;
    GstElement *webrtcbin = nullptr;
    GstElement *video_queue = nullptr;
    GstElement *audio_queue = nullptr;
    GObject *data_channel = nullptr;
};

namespace {

void print_offer(GstPromise *promise, gpointer user_data) {
    auto *peer = static_cast<WebRtcPipeline::Peer *>(user_data);
    const GstStructure *reply = gst_promise_get_reply(promise);
    GstWebRTCSessionDescription *offer = nullptr;
    gst_structure_get(reply, "offer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &offer, nullptr);
    if (offer) {
        gchar *sdp_text = gst_sdp_message_as_text(offer->sdp);
        if (peer->pipeline->signaling_client()) {
            const auto payload = json{{"type", "offer"}, {"sdp", sdp_text}}.dump();
            peer->pipeline->signaling_client()->send("offer", peer->pipeline->room(), payload, peer->peer_id);
        }
        std::cout << "[WEBRTC] SDP offer sent to " << peer->peer_id << std::endl;
        g_signal_emit_by_name(peer->webrtcbin, "set-local-description", offer, nullptr);
        g_free(sdp_text);
        gst_webrtc_session_description_free(offer);
    }
    gst_promise_unref(promise);
}

void on_negotiation_needed(GstElement *webrtc, gpointer user_data) {
    auto *promise = gst_promise_new_with_change_func(print_offer, user_data, nullptr);
    g_signal_emit_by_name(webrtc, "create-offer", nullptr, promise);
}

// With NetworkMode=host the container sees every interface on the VPS, including unrelated Docker
// bridge networks from other apps sharing the host. Those produce dozens of irrelevant ICE host
// candidates that can win ICE priority over the real public IP and leave media flowing nowhere even
// though the connection reports "connected" (DTLS only needs one working component). If PUBLIC_IP is
// set, only forward UDP candidates for that address (plus the end-of-candidates marker).
bool should_forward_candidate(const std::string &candidate) {
    if (candidate.empty()) return true; // end-of-candidates marker
    static const char *public_ip = std::getenv("PUBLIC_IP");
    if (!public_ip || !*public_ip) return true;
    if (candidate.find(" TCP ") != std::string::npos) return false;
    return candidate.find(std::string(" ") + public_ip + " ") != std::string::npos;
}

void on_ice_candidate(GstElement *, guint mline, gchar *candidate, gpointer user_data) {
    auto *peer = static_cast<WebRtcPipeline::Peer *>(user_data);
    const std::string candidate_str = candidate ? candidate : "";
    if (!should_forward_candidate(candidate_str)) return;
    if (peer->pipeline->signaling_client()) {
        const auto payload = json{{"candidate", candidate}, {"sdpMLineIndex", mline}}.dump();
        peer->pipeline->signaling_client()->send("candidate", peer->pipeline->room(), payload, peer->peer_id);
    }
    std::cout << "[WEBRTC] ICE candidate to " << peer->peer_id << " mline=" << mline << " " << candidate << std::endl;
}

void on_data_channel_message(GstWebRTCDataChannel *, GBytes *message, gpointer user_data) {
    auto *peer = static_cast<WebRtcPipeline::Peer *>(user_data);
    const auto &handler = peer->pipeline->input_handler();
    if (!handler || !message) return;
    gsize size = 0;
    const auto *data = static_cast<const std::uint8_t *>(g_bytes_get_data(message, &size));
    if (size < 3 || data[0] != 0xFF) return;
    const std::uint16_t mask = static_cast<std::uint16_t>(data[1] | (data[2] << 8));
    handler(peer->player_number, mask);
}

void drain_bus(GstElement *pipeline) {
    if (!pipeline) return;
    auto *bus = gst_element_get_bus(pipeline);
    while (auto *message = gst_bus_pop_filtered(bus, static_cast<GstMessageType>(GST_MESSAGE_ERROR | GST_MESSAGE_WARNING))) {
        if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
            GError *error = nullptr;
            gchar *debug = nullptr;
            gst_message_parse_error(message, &error, &debug);
            std::cerr << "[WEBRTC] pipeline error: " << (error ? error->message : "unknown") << std::endl;
            if (debug) std::cerr << "[WEBRTC] pipeline debug: " << debug << std::endl;
            g_free(debug);
            g_clear_error(&error);
        } else {
            GError *warning = nullptr;
            gchar *debug = nullptr;
            gst_message_parse_warning(message, &warning, &debug);
            std::cerr << "[WEBRTC] pipeline warning: " << (warning ? warning->message : "unknown") << std::endl;
            if (debug) std::cerr << "[WEBRTC] pipeline debug: " << debug << std::endl;
            g_free(debug);
            g_clear_error(&warning);
        }
        gst_message_unref(message);
    }
    gst_object_unref(bus);
}

} // namespace

WebRtcPipeline::WebRtcPipeline() = default;

WebRtcPipeline::~WebRtcPipeline() { stop(); }

void WebRtcPipeline::start(unsigned width, unsigned height, double fps, unsigned bitrate_kbps, unsigned sample_rate,
                            SignalingClient *signaling, std::string room, InputHandler input_handler) {
    if (active()) return;
    signaling_ = signaling;
    room_ = std::move(room);
    input_handler_ = std::move(input_handler);
    sample_rate_ = sample_rate > 0 ? sample_rate : 48000;
    const auto video_caps_str = "video/x-raw,format=RGBA,width=" + std::to_string(width) +
                      ",height=" + std::to_string(height) + ",framerate=" +
                      std::to_string(static_cast<unsigned>(fps * 1000)) + "/1000";
    const auto description = "appsrc name=video_source is-live=true format=time do-timestamp=true block=false max-buffers=1 leaky-type=downstream ! "
        // threads=2: x264 defaults to one encoder thread per detected CPU, but Docker's NanoCpus quota
        // (see signaling's spawnGameServer) doesn't change what /proc reports inside the container, so
        // without a cap it would happily spin up as many threads as the *host* has cores and thrash
        // against its own quota — worse, it also competes with the emulator's own CPU budget in the same
        // container. Two encoder threads is plenty for 1080p60 at ultrafast and leaves room for the core.
        "videoconvert ! video/x-raw,format=I420 ! x264enc tune=zerolatency speed-preset=ultrafast threads=2 bitrate=" + std::to_string(bitrate_kbps) +
        " key-int-max=10 bframes=0 ! h264parse config-interval=1 ! video/x-h264,stream-format=byte-stream,alignment=au ! rtph264pay config-interval=1 pt=96 ! "
        "application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000 ! tee name=video_tee allow-not-linked=true "
        // opusenc otherwise defaults to a much higher VBR target than game audio (chiptune/simple mixes,
        // usually mono or near-mono source material) actually needs; explicit low bitrate saves real
        // bandwidth for every viewer at no audible cost, and drops further on the low-bandwidth video tier.
        "appsrc name=audio_source is-live=true format=time do-timestamp=true block=false max-buffers=2 leaky-type=downstream ! "
        "audioconvert ! audioresample ! audio/x-raw,rate=48000 ! opusenc bitrate=" + std::to_string(bitrate_kbps <= 800 ? 24000 : 40000) + " ! rtpopuspay pt=97 ! "
        "application/x-rtp,media=audio,encoding-name=OPUS,payload=97,clock-rate=48000 ! tee name=audio_tee allow-not-linked=true";
    GError *error = nullptr;
    pipeline_ = gst_parse_launch(description.c_str(), &error);
    if (!pipeline_) {
        const std::string message = error ? error->message : "unknown GStreamer error";
        if (error) g_error_free(error);
        throw std::runtime_error("cannot create webrtcbin pipeline: " + message);
    }
    source_ = gst_bin_get_by_name(GST_BIN(pipeline_), "video_source");
    audio_source_ = gst_bin_get_by_name(GST_BIN(pipeline_), "audio_source");
    video_tee_ = gst_bin_get_by_name(GST_BIN(pipeline_), "video_tee");
    audio_tee_ = gst_bin_get_by_name(GST_BIN(pipeline_), "audio_tee");
    if (!source_ || !audio_source_ || !video_tee_ || !audio_tee_) {
        throw std::runtime_error("webrtcbin pipeline is missing an expected element");
    }
    auto *video_caps = gst_caps_from_string(video_caps_str.c_str());
    gst_app_src_set_caps(GST_APP_SRC(source_), video_caps);
    gst_caps_unref(video_caps);
    const auto audio_caps_str = "audio/x-raw,format=S16LE,channels=2,layout=interleaved,rate=" + std::to_string(sample_rate_);
    auto *audio_caps = gst_caps_from_string(audio_caps_str.c_str());
    gst_app_src_set_caps(GST_APP_SRC(audio_source_), audio_caps);
    gst_caps_unref(audio_caps);
    frame_duration_ns_ = static_cast<std::uint64_t>(1'000'000'000.0 / fps);
    const auto state_result = gst_element_set_state(pipeline_, GST_STATE_PLAYING);
    if (state_result == GST_STATE_CHANGE_FAILURE) {
        auto *bus = gst_element_get_bus(pipeline_);
        auto *message = gst_bus_timed_pop_filtered(bus, 2 * GST_SECOND, static_cast<GstMessageType>(GST_MESSAGE_ERROR | GST_MESSAGE_WARNING));
        if (message && GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
            GError *state_error = nullptr;
            gchar *debug = nullptr;
            gst_message_parse_error(message, &state_error, &debug);
            std::cerr << "[WEBRTC] pipeline error: " << (state_error ? state_error->message : "unknown") << std::endl;
            if (debug) std::cerr << "[WEBRTC] pipeline debug: " << debug << std::endl;
            g_free(debug);
            g_clear_error(&state_error);
        }
        if (message) gst_message_unref(message);
        gst_object_unref(bus);
        stop();
        throw std::runtime_error("cannot start webrtcbin pipeline");
    }
    gst_element_get_state(pipeline_, nullptr, nullptr, 2 * GST_SECOND);
    std::cout << "[WEBRTC] webrtcbin pipeline started" << std::endl;
}

void WebRtcPipeline::add_peer(const std::string &peer_id, unsigned player_number) {
    if (!active() || peers_.count(peer_id)) return;
    auto peer = std::make_unique<Peer>();
    peer->pipeline = this;
    peer->peer_id = peer_id;
    peer->player_number = player_number;
    peer->webrtcbin = gst_element_factory_make("webrtcbin", nullptr);
    peer->video_queue = gst_element_factory_make("queue", nullptr);
    peer->audio_queue = gst_element_factory_make("queue", nullptr);
    if (!peer->webrtcbin || !peer->video_queue || !peer->audio_queue) {
        std::cerr << "[WEBRTC] failed to create elements for peer " << peer_id << std::endl;
        return;
    }
    g_object_set(peer->webrtcbin, "bundle-policy", 3 /* GST_WEBRTC_BUNDLE_POLICY_MAX_BUNDLE */, nullptr);
    g_object_set(peer->webrtcbin, "stun-server", "stun://stun.l.google.com:19302", nullptr);
    // webrtcbin's internal jitterbuffer defaults to ~200ms; pull all the way down for minimal
    // glass-to-glass latency. On a controlled VPS→browser link this is safe.
    g_object_set(peer->webrtcbin, "latency", 0, nullptr);
    g_object_set(peer->webrtcbin, "ice-candidate-pool-size", 1u, nullptr);
    // Drop old buffers instead of queueing them: a laggy peer should skip ahead rather than build up
    // latency. 150ms keeps video tight without starved-decoder risk; audio stays even tighter.
    g_object_set(peer->video_queue, "leaky", 2 /* downstream */, "max-size-buffers", 60, "max-size-time", (guint64)50000000 /* 50ms */, "max-size-bytes", 0, nullptr);
    g_object_set(peer->audio_queue, "leaky", 2 /* downstream */, "max-size-buffers", 60, "max-size-time", (guint64)50000000 /* 50ms */, "max-size-bytes", 0, nullptr);
    gst_bin_add_many(GST_BIN(pipeline_), peer->webrtcbin, peer->video_queue, peer->audio_queue, nullptr);
    if (!gst_element_link(video_tee_, peer->video_queue) || !gst_element_link(peer->video_queue, peer->webrtcbin) ||
        !gst_element_link(audio_tee_, peer->audio_queue) || !gst_element_link(peer->audio_queue, peer->webrtcbin)) {
        std::cerr << "[WEBRTC] failed to link peer " << peer_id << " into tee" << std::endl;
        return;
    }
    gst_element_sync_state_with_parent(peer->audio_queue);
    gst_element_sync_state_with_parent(peer->video_queue);
    gst_element_sync_state_with_parent(peer->webrtcbin);

    auto *peer_ptr = peer.get();
    g_signal_connect(peer->webrtcbin, "on-negotiation-needed", G_CALLBACK(on_negotiation_needed), peer_ptr);
    g_signal_connect(peer->webrtcbin, "on-ice-candidate", G_CALLBACK(on_ice_candidate), peer_ptr);

    GstWebRTCDataChannel *channel = nullptr;
    // Unreliable + unordered: game input benefits from low latency over guaranteed delivery.
    // Each message carries the full 16-bit button bitmask, so a lost packet is corrected by the
    // very next key event — no stuck buttons, no retransmit-induced head-of-line blocking.
    g_signal_emit_by_name(peer->webrtcbin, "create-data-channel", "input", nullptr, &channel);
    if (channel) {
        g_object_set(channel, "ordered", FALSE, "max-retransmits", 0, nullptr);
        peer->data_channel = reinterpret_cast<GObject *>(channel);
        g_signal_connect(channel, "on-message-data", G_CALLBACK(on_data_channel_message), peer_ptr);
    } else {
        std::cerr << "[WEBRTC] failed to create input data channel for peer " << peer_id << std::endl;
    }

    std::cout << "[WEBRTC] peer added room=" << room_ << " peer=" << peer_id << " player=" << player_number << std::endl;
    peers_.emplace(peer_id, std::move(peer));
}

void WebRtcPipeline::remove_peer(const std::string &peer_id) {
    const auto it = peers_.find(peer_id);
    if (it == peers_.end()) return;
    auto &peer = *it->second;
    if (peer.data_channel) g_object_unref(peer.data_channel);
    if (peer.webrtcbin) {
        gst_element_set_state(peer.webrtcbin, GST_STATE_NULL);
        gst_bin_remove(GST_BIN(pipeline_), peer.webrtcbin);
    }
    if (peer.video_queue) {
        gst_element_set_state(peer.video_queue, GST_STATE_NULL);
        gst_bin_remove(GST_BIN(pipeline_), peer.video_queue);
    }
    if (peer.audio_queue) {
        gst_element_set_state(peer.audio_queue, GST_STATE_NULL);
        gst_bin_remove(GST_BIN(pipeline_), peer.audio_queue);
    }
    std::cout << "[WEBRTC] peer removed room=" << room_ << " peer=" << peer_id << std::endl;
    peers_.erase(it);
}

void WebRtcPipeline::push_rgba(const std::uint8_t *data, std::size_t size, std::uint64_t frame_number) {
    if (!active()) return;
    drain_bus(pipeline_);
    auto *buffer = gst_buffer_new_allocate(nullptr, size, nullptr);
    if (!buffer) throw std::runtime_error("cannot allocate WebRTC video buffer");
    gst_buffer_fill(buffer, 0, data, size);
    GST_BUFFER_DURATION(buffer) = frame_duration_ns_;
    if (gst_app_src_push_buffer(GST_APP_SRC(source_), buffer) != GST_FLOW_OK) {
        throw std::runtime_error("webrtcbin appsrc rejected video frame");
    }
}

void WebRtcPipeline::push_pcm(const std::int16_t *data, std::size_t frames) {
    if (!active() || !audio_source_ || frames == 0) return;
    const auto size = frames * 2 * sizeof(std::int16_t);
    auto *buffer = gst_buffer_new_allocate(nullptr, size, nullptr);
    if (!buffer) throw std::runtime_error("cannot allocate WebRTC audio buffer");
    gst_buffer_fill(buffer, 0, data, size);
    const auto duration = static_cast<std::uint64_t>(frames) * 1'000'000'000ULL / sample_rate_;
    GST_BUFFER_DURATION(buffer) = duration;
    if (gst_app_src_push_buffer(GST_APP_SRC(audio_source_), buffer) != GST_FLOW_OK) {
        std::cerr << "[WEBRTC] audio appsrc rejected buffer" << std::endl;
    }
}

void WebRtcPipeline::handle_signaling(const std::string &peer_id, const std::string &type, const std::string &payload) {
    const auto it = peers_.find(peer_id);
    if (it == peers_.end()) return;
    auto *webrtcbin = it->second->webrtcbin;
    const auto message = json::parse(payload, nullptr, false);
    if (message.is_discarded()) return;
    if (type == "answer" && message.contains("sdp")) {
        GstSDPMessage *sdp = nullptr;
        if (gst_sdp_message_new_from_text(message.at("sdp").get<std::string>().c_str(), &sdp) == GST_SDP_OK) {
            auto *description = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_ANSWER, sdp);
            g_signal_emit_by_name(webrtcbin, "set-remote-description", description, nullptr);
            gst_webrtc_session_description_free(description);
            std::cout << "[WEBRTC] remote SDP answer applied for " << peer_id << std::endl;
        }
    } else if (type == "candidate" && message.contains("candidate")) {
        const auto mline = message.value("sdpMLineIndex", 0u);
        g_signal_emit_by_name(webrtcbin, "add-ice-candidate", mline, message.at("candidate").get<std::string>().c_str());
    }
}

void WebRtcPipeline::stop() {
    for (auto &[id, peer] : peers_) {
        if (peer->data_channel) g_object_unref(peer->data_channel);
        if (peer->webrtcbin) gst_element_set_state(peer->webrtcbin, GST_STATE_NULL);
    }
    peers_.clear();
    if (source_) {
        gst_app_src_end_of_stream(GST_APP_SRC(source_));
        gst_object_unref(source_);
        source_ = nullptr;
    }
    if (audio_source_) {
        gst_app_src_end_of_stream(GST_APP_SRC(audio_source_));
        gst_object_unref(audio_source_);
        audio_source_ = nullptr;
    }
    if (video_tee_) gst_object_unref(video_tee_);
    if (audio_tee_) gst_object_unref(audio_tee_);
    if (pipeline_) {
        gst_element_set_state(pipeline_, GST_STATE_NULL);
        gst_object_unref(pipeline_);
        pipeline_ = nullptr;
    }
    video_tee_ = nullptr;
    audio_tee_ = nullptr;
    signaling_ = nullptr;
    input_handler_ = nullptr;
    room_.clear();
}

bool WebRtcPipeline::active() const { return pipeline_ != nullptr && source_ != nullptr; }

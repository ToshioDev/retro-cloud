#include "gstreamer_pipeline.h"

#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#include <gst/video/video.h>

#include <stdexcept>
#include <string>

namespace {

std::string quote_path(const std::string &path) {
    std::string quoted = "\"";
    for (const char character : path) {
        if (character == '\\' || character == '"') quoted += '\\';
        quoted += character;
    }
    quoted += '"';
    return quoted;
}

} // namespace

GStreamerPipeline::GStreamerPipeline() = default;

GStreamerPipeline::~GStreamerPipeline() { stop(); }

void GStreamerPipeline::start(unsigned width, unsigned height, double fps, const std::string &output_path, unsigned bitrate_kbps) {
    if (active()) return;
    if (output_path.empty()) return;

    const auto caps = "video/x-raw,format=RGBA,width=" + std::to_string(width) +
                      ",height=" + std::to_string(height) + ",framerate=" +
                      std::to_string(static_cast<unsigned>(fps * 1000)) + "/1000";
    const bool use_h264 = gst_element_factory_find("x264enc") != nullptr;
    const auto sink = quote_path(output_path);
    const auto encoder = use_h264
        ? "videoconvert ! x264enc tune=zerolatency speed-preset=ultrafast bitrate=" + std::to_string(bitrate_kbps) + " key-int-max=60 bframes=0 ! filesink location=" + sink
        : "videoconvert ! vp8enc deadline=1 cpu-used=8 target-bitrate=" + std::to_string(bitrate_kbps * 1000) + " ! webmmux ! filesink location=" + sink;
    const auto description = "appsrc name=video_source is-live=true format=time do-timestamp=false block=false max-buffers=2 leaky-type=downstream ! " + encoder;
    g_print("[VIDEO] GStreamer pipeline: %s\n", description.c_str());

    GError *error = nullptr;
    pipeline_ = gst_parse_launch(description.c_str(), &error);
    if (!pipeline_) {
        const std::string message = error ? error->message : "unknown GStreamer error";
        if (error) g_error_free(error);
        throw std::runtime_error("cannot create video pipeline: " + message);
    }
    source_ = gst_bin_get_by_name(GST_BIN(pipeline_), "video_source");
    if (!source_) throw std::runtime_error("video pipeline has no appsrc");
    auto *video_caps = gst_caps_from_string(caps.c_str());
    if (!video_caps) throw std::runtime_error("cannot create GStreamer video caps");
    gst_app_src_set_caps(GST_APP_SRC(source_), video_caps);
    gst_caps_unref(video_caps);
    frame_duration_ns_ = static_cast<std::uint64_t>(1'000'000'000.0 / fps);
    if (gst_element_set_state(pipeline_, GST_STATE_PLAYING) == GST_STATE_CHANGE_FAILURE) {
        stop();
        throw std::runtime_error("cannot start GStreamer video pipeline");
    }
    g_print("[VIDEO] GStreamer encoder: %s\n", use_h264 ? "H.264 x264enc" : "VP8 vp8enc fallback");
    gst_element_get_state(pipeline_, nullptr, nullptr, 5 * GST_SECOND);
}

void GStreamerPipeline::push_rgba(const std::uint8_t *data, std::size_t size, std::uint64_t frame_number) {
    if (!active()) return;
    auto *buffer = gst_buffer_new_allocate(nullptr, size, nullptr);
    if (!buffer) {
        g_printerr("[VIDEO] GStreamer buffer allocation failed (frame %lu)\n", frame_number);
        return;
    }
    gst_buffer_fill(buffer, 0, data, size);
    GST_BUFFER_PTS(buffer) = frame_number * frame_duration_ns_;
    GST_BUFFER_DTS(buffer) = GST_CLOCK_TIME_NONE;
    GST_BUFFER_DURATION(buffer) = frame_duration_ns_;
    const auto result = gst_app_src_push_buffer(GST_APP_SRC(source_), buffer);
    if (result != GST_FLOW_OK) {
        g_printerr("[VIDEO] GStreamer push failed: %s\n", gst_flow_get_name(result));
    }
}

void GStreamerPipeline::stop() {
    if (source_) {
        gst_app_src_end_of_stream(GST_APP_SRC(source_));
        if (pipeline_) {
            auto *bus = gst_element_get_bus(pipeline_);
            auto *message = gst_bus_timed_pop_filtered(bus, 2 * GST_SECOND, static_cast<GstMessageType>(GST_MESSAGE_EOS | GST_MESSAGE_ERROR));
            if (message && GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
                GError *error = nullptr;
                gchar *debug = nullptr;
                gst_message_parse_error(message, &error, &debug);
                g_printerr("[VIDEO] GStreamer error: %s\n", error ? error->message : "unknown");
                if (debug) g_printerr("[VIDEO] GStreamer debug: %s\n", debug);
                g_free(debug);
                g_clear_error(&error);
            }
            if (message) gst_message_unref(message);
            gst_object_unref(bus);
        }
        gst_object_unref(source_);
        source_ = nullptr;
    }
    if (pipeline_) {
        gst_element_set_state(pipeline_, GST_STATE_NULL);
        gst_object_unref(pipeline_);
        pipeline_ = nullptr;
    }
}

bool GStreamerPipeline::active() const { return pipeline_ != nullptr && source_ != nullptr; }

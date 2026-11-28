#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

struct _GstElement;
using GstElement = _GstElement;

class GStreamerPipeline {
public:
    GStreamerPipeline();
    ~GStreamerPipeline();

    GStreamerPipeline(const GStreamerPipeline &) = delete;
    GStreamerPipeline &operator=(const GStreamerPipeline &) = delete;

    void start(unsigned width, unsigned height, double fps, const std::string &output_path, unsigned bitrate_kbps);
    void push_rgba(const std::uint8_t *data, std::size_t size, std::uint64_t frame_number);
    void stop();
    bool active() const;

private:
    GstElement *pipeline_ = nullptr;
    GstElement *source_ = nullptr;
    std::uint64_t frame_duration_ns_ = 0;
};

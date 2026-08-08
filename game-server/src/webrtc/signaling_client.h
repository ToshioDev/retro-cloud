#pragma once

#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

class SignalingClient {
public:
    struct Impl;
    // (type, payload, from)
    using MessageHandler = std::function<void(const std::string &, const std::string &, const std::string &)>;

    SignalingClient();
    ~SignalingClient();

    SignalingClient(const SignalingClient &) = delete;
    SignalingClient &operator=(const SignalingClient &) = delete;

    void connect(const std::string &url, const std::string &room, MessageHandler handler);
    void poll();
    void send(const std::string &type, const std::string &room, const std::string &payload, const std::string &to = "");
    void close();
    bool connected() const;

private:
    std::unique_ptr<Impl> impl_;
};

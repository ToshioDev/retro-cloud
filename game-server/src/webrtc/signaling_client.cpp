#include "signaling_client.h"

#include <libwebsockets.h>
#include <nlohmann/json.hpp>

#include <cstring>
#include <deque>
#include <iostream>
#include <stdexcept>
#include <vector>

using json = nlohmann::json;

struct SignalingClient::Impl {
    lws_context *context = nullptr;
    lws *socket = nullptr;
    std::string room;
    std::string host;
    std::string path;
    int port = 80;
    bool secure = false;
    bool open = false;
    bool connecting = false;
    bool running = false;
    std::chrono::steady_clock::time_point next_retry{};
    std::mutex outgoing_mutex;
    std::deque<std::vector<unsigned char>> outgoing;
    MessageHandler handler;
    std::thread service_thread;
};

namespace {

SignalingClient::Impl *current = nullptr;

int callback(lws *socket, lws_callback_reasons reason, void *user, void *in, size_t length) {
    (void)user;
    auto *client = current;
    if (!client) return 0;
    switch (reason) {
    case LWS_CALLBACK_CLIENT_ESTABLISHED:
        std::cout << "[SIGNALING] connected" << std::endl;
        client->socket = socket;
        client->open = true;
        client->connecting = false;
        {
            const auto message = json{{"type", "join"}, {"room", client->room}, {"role", "host"}}.dump();
            std::vector<unsigned char> frame(LWS_PRE + message.size(), 0);
            std::memcpy(frame.data() + LWS_PRE, message.data(), message.size());
            std::lock_guard<std::mutex> lock(client->outgoing_mutex);
            client->outgoing.push_back(std::move(frame));
        }
        lws_callback_on_writable(socket);
        break;
    case LWS_CALLBACK_CLIENT_RECEIVE: {
        const auto message = json::parse(static_cast<const char *>(in), static_cast<const char *>(in) + length, nullptr, false);
        if (message.is_discarded() || !message.contains("type")) break;
        const auto type = message.at("type").get<std::string>();
        const auto payload = message.value("payload", json::object()).dump();
        const auto from = message.value("from", std::string());
        if (client->handler) client->handler(type, payload, from);
        break;
    }
    case LWS_CALLBACK_CLIENT_WRITEABLE: {
        std::lock_guard<std::mutex> lock(client->outgoing_mutex);
        if (!client->outgoing.empty()) {
            auto &frame = client->outgoing.front();
            lws_write(socket, frame.data() + LWS_PRE, frame.size() - LWS_PRE, LWS_WRITE_TEXT);
            client->outgoing.pop_front();
            if (!client->outgoing.empty()) lws_callback_on_writable(socket);
        }
        break;
    }
    case LWS_CALLBACK_CLIENT_CONNECTION_ERROR:
        std::cerr << "[SIGNALING] connection error: "
                   << (in ? std::string(static_cast<const char *>(in), length) : "unknown") << std::endl;
        client->open = false;
        client->connecting = false;
        client->socket = nullptr;
        client->next_retry = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        break;
    case LWS_CALLBACK_CLOSED:
        std::cerr << "[SIGNALING] connection closed" << std::endl;
        client->open = false;
        client->connecting = false;
        client->socket = nullptr;
        client->next_retry = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        break;
    default:
        break;
    }
    return 0;
}

lws_protocols protocols[] = {{"retro-signaling", callback, 0, 64 * 1024, 0, nullptr, 0}, LWS_PROTOCOL_LIST_TERM};

void parse_url(SignalingClient::Impl &client, const std::string &url) {
    const auto scheme_end = url.find("://");
    if (scheme_end == std::string::npos) throw std::runtime_error("SIGNALING_URL must use ws:// or wss://");
    const auto scheme = url.substr(0, scheme_end);
    client.secure = scheme == "wss";
    if (!client.secure && scheme != "ws") throw std::runtime_error("SIGNALING_URL must use ws:// or wss://");
    const auto authority_start = scheme_end + 3;
    const auto path_start = url.find('/', authority_start);
    const auto authority = url.substr(authority_start, path_start == std::string::npos ? std::string::npos : path_start - authority_start);
    client.path = path_start == std::string::npos ? "/" : url.substr(path_start);
    const auto port_start = authority.find(':');
    client.host = port_start == std::string::npos ? authority : authority.substr(0, port_start);
    client.port = port_start == std::string::npos ? (client.secure ? 443 : 80) : std::stoi(authority.substr(port_start + 1));
}

void attempt_connect(SignalingClient::Impl &client) {
    lws_client_connect_info connection{};
    connection.context = client.context;
    connection.address = client.host.c_str();
    connection.port = client.port;
    connection.path = client.path.c_str();
    connection.host = client.host.c_str();
    connection.origin = client.host.c_str();
    connection.protocol = protocols[0].name;
    connection.userdata = nullptr;
    connection.ssl_connection = client.secure ? LCCSCF_USE_SSL : 0;
    client.connecting = true;
    client.socket = lws_client_connect_via_info(&connection);
    if (!client.socket) {
        std::cerr << "[SIGNALING] connect attempt failed to schedule" << std::endl;
        client.connecting = false;
        client.next_retry = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    }
}

} // namespace

SignalingClient::SignalingClient() : impl_(std::make_unique<Impl>()) {}
SignalingClient::~SignalingClient() { close(); }

void SignalingClient::connect(const std::string &url, const std::string &room, MessageHandler handler) {
    parse_url(*impl_, url);
    impl_->room = room;
    impl_->handler = std::move(handler);
    lws_set_log_level(LLL_ERR | LLL_WARN, nullptr);
    lws_context_creation_info context_info{};
    context_info.port = CONTEXT_PORT_NO_LISTEN;
    context_info.protocols = protocols;
    context_info.options = LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT;
    impl_->context = lws_create_context(&context_info);
    if (!impl_->context) throw std::runtime_error("cannot create signaling WebSocket context");
    current = impl_.get();
    attempt_connect(*impl_);
    // lws_service() can block far longer than its timeout depending on platform poll
    // internals; run it on its own thread so it can never stall the emulation/video loop.
    impl_->running = true;
    impl_->service_thread = std::thread([this]() {
        while (impl_->running) {
            lws_service(impl_->context, 10);
            if (!impl_->open && !impl_->connecting && std::chrono::steady_clock::now() >= impl_->next_retry) {
                std::cerr << "[SIGNALING] retrying connection to " << impl_->host << ":" << impl_->port << impl_->path << std::endl;
                attempt_connect(*impl_);
            }
        }
    });
}

void SignalingClient::poll() {
    // Servicing now runs on a dedicated background thread (see connect()); nothing to do here.
}

void SignalingClient::send(const std::string &type, const std::string &room, const std::string &payload, const std::string &to) {
    if (!impl_->context) return;
    auto message_json = json{{"type", type}, {"room", room}, {"payload", json::parse(payload)}};
    if (!to.empty()) message_json["to"] = to;
    const auto message = message_json.dump();
    std::vector<unsigned char> frame(LWS_PRE + message.size(), 0);
    std::memcpy(frame.data() + LWS_PRE, message.data(), message.size());
    {
        std::lock_guard<std::mutex> lock(impl_->outgoing_mutex);
        impl_->outgoing.push_back(std::move(frame));
    }
    if (impl_->socket) lws_callback_on_writable(impl_->socket);
}

void SignalingClient::close() {
    impl_->running = false;
    if (impl_->service_thread.joinable()) impl_->service_thread.join();
    if (impl_->context) lws_context_destroy(impl_->context);
    impl_->context = nullptr;
    impl_->socket = nullptr;
    impl_->open = false;
    current = nullptr;
}

bool SignalingClient::connected() const { return impl_->open; }

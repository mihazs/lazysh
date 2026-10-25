#include <algorithm>
#include <cerrno>
#include <cstring>
#include <locale.h>
#include <memory>
#include <poll.h>
#include <stdexcept>
#include <string>
#include <vector>
#include "src/util/dos_assert.h"

#include "src/network/networktransport.h"
#ifdef LAZYSH_MOSH_TEST_FIXTURES
#include "src/network/compressor.h"
#endif
#include "src/network/networktransport-impl.h"
#include "src/network/transportsender-impl.h"
#include "src/statesync/completeterminal.h"
#include "src/statesync/user.h"
#include "src/util/timestamp.h"

// lazysh embedding, 2026-10-24: fixed xterm capabilities; no process TERM/terminfo access.
Terminal::Display::Display(bool use_environment)
    : has_ech(true), has_bce(true), has_title(true), smcup(nullptr), rmcup(nullptr) {
    if (use_environment) throw std::runtime_error("Environment terminal initialization is disabled");
}

namespace {
constexpr size_t output_limit = 8 * 1024 * 1024;
using Transport = Network::Transport<Network::UserStream, Terminal::Complete>;

struct Locale {
    locale_t current = nullptr;
    locale_t previous = nullptr;
    Locale() {
        for (const char* name : {"C.UTF-8", "en_US.UTF-8", "UTF-8"}) {
            current = newlocale(LC_CTYPE_MASK, name, nullptr);
            if (current) break;
        }
        if (!current) throw std::runtime_error("No thread-local UTF-8 locale is available");
        previous = uselocale(current);
        if (!previous) { freelocale(current); current = nullptr; throw std::runtime_error("Cannot select thread-local UTF-8 locale"); }
    }
    ~Locale() { if (current) { uselocale(previous); freelocale(current); } }
};

struct Client {
    std::unique_ptr<Transport> network;
    Terminal::Display display{false};
    Terminal::Framebuffer last;
    uint64_t state_num = 0;
    bool initialized = false;
    bool output_paused = false;
    std::string output;
    Client(const char* key, const char* address, const char* port, unsigned cols, unsigned rows)
        : last(cols, rows) {
        Network::UserStream input;
        Terminal::Complete remote(cols, rows);
        network = std::make_unique<Transport>(input, remote, key, address, port);
        network->get_current_state().push_back(Parser::Resize(cols, rows));
    }
};
void dimensions(unsigned cols, unsigned rows) {
    if (!cols || !rows || cols > 512 || rows > 256 || uint64_t(cols) * rows > 32768)
        throw std::runtime_error("Mosh screen exceeds 512 columns, 256 rows, or 32768 cells");
}
void error_text(char* buffer, size_t capacity, const char* text) noexcept {
    if (!buffer || !capacity) return;
    const size_t length = std::min(capacity - 1, std::strlen(text));
    std::memcpy(buffer, text, length);
    buffer[length] = 0;
}
template <typename F> int boundary(F operation, char* error, size_t capacity) noexcept {
    try { Locale locale; freeze_timestamp(); operation(); return 0; }
    catch (const std::exception& e) { error_text(error, capacity, e.what()); }
    catch (...) { error_text(error, capacity, "Mosh operation failed"); }
    return -1;
}
}

extern "C" int lazysh_mosh_new(const char* key, const char* address, unsigned port, unsigned cols, unsigned rows,
                                void** result, char* error, size_t capacity) noexcept {
    return boundary([&] {
        dimensions(cols, rows);
        if (!key || !address || !result || !port || port > 65535) throw std::runtime_error("Invalid Mosh endpoint");
        *result = new Client(key, address, std::to_string(port).c_str(), cols, rows);
    }, error, capacity);
}
extern "C" int lazysh_mosh_write(void* pointer, const unsigned char* bytes, size_t length, char* error, size_t capacity) noexcept {
    return boundary([&] {
        auto& input = static_cast<Client*>(pointer)->network->get_current_state();
        if (length > 65536 || input.size() > 65536 - length) throw std::runtime_error("Mosh input queue is full");
        for (size_t i = 0; i < length; i++) input.push_back(Parser::UserByte(bytes[i]));
    }, error, capacity);
}
extern "C" int lazysh_mosh_resize(void* pointer, unsigned cols, unsigned rows, char* error, size_t capacity) noexcept {
    return boundary([&] {
        dimensions(cols, rows);
        auto& input = static_cast<Client*>(pointer)->network->get_current_state();
        if (input.size() >= 65536) throw std::runtime_error("Mosh input queue is full");
        input.push_back(Parser::Resize(cols, rows));
    }, error, capacity);
}
extern "C" int lazysh_mosh_step(void* pointer, size_t* length, int* finished, int* connected, size_t* input_capacity, unsigned* next_poll, char* error, size_t capacity) noexcept {
    return boundary([&] {
        auto& client = *static_cast<Client*>(pointer);
        auto& network = *client.network;
        network.tick();
        auto fds = network.fds();
        std::vector<pollfd> polling;
        for (int fd : fds) polling.push_back({fd, POLLIN, 0});
        for (unsigned received = 0; received < 64; received++) {
            const int ready = poll(polling.data(), polling.size(), 0);
            if (ready < 0) { if (errno == EINTR) break; throw std::runtime_error("Cannot poll Mosh socket"); }
            if (!ready) break;
            try { network.recv(); }
            catch (const Crypto::CryptoException& e) { if (e.fatal) throw; }
            catch (const Network::NetworkException& e) {
                if (e.function == "Received oversize datagram") continue;
                const bool transient = e.the_errno == EAGAIN || e.the_errno == EWOULDBLOCK || e.the_errno == EINTR
                    || e.the_errno == ECONNREFUSED || e.the_errno == EHOSTUNREACH || e.the_errno == ENETUNREACH || e.the_errno == ENETDOWN;
                if (!transient) throw;
            }
        }
        freeze_timestamp();
        network.tick();
        client.output.clear();
        const auto& remote = network.get_latest_remote_state();
        if (!client.output_paused && (!client.initialized || client.state_num != remote.num)) {
            client.output = client.display.new_frame(client.initialized, client.last, remote.state.get_fb());
            if (client.output.size() > output_limit) throw std::runtime_error("Mosh display output exceeds 8 MiB");
            client.last = remote.state.get_fb();
            client.state_num = remote.num;
            client.initialized = true;
        }
        *length = client.output.size();
        *finished = network.shutdown_acknowledged() || network.counterparty_shutdown_ack_sent() || network.shutdown_ack_timed_out();
        *connected = remote.num != 0 && remote.num != uint64_t(-1);
        *input_capacity = *finished || network.shutdown_in_progress() ? 0 : 65536 - std::min<size_t>(65536, network.get_current_state().size());
        *next_poll = std::min(200, std::max(1, network.wait_time()));
    }, error, capacity);
}
extern "C" int lazysh_mosh_pause_output(void* pointer, int paused, char* error, size_t capacity) noexcept {
    return boundary([&] {
        auto& client = *static_cast<Client*>(pointer);
        const bool next = paused != 0;
        if (client.output_paused && !next) client.initialized = false;
        client.output_paused = next;
        client.output.clear();
    }, error, capacity);
}
extern "C" int lazysh_mosh_wait(void* pointer, unsigned wait_ms, char* error, size_t capacity) noexcept {
    // Only this client's owning thread can mutate its sockets. Waiting touches no shared Mosh clock/nonce/locale state.
    try {
        auto fds = static_cast<Client*>(pointer)->network->fds();
        std::vector<pollfd> polling;
        for (int fd : fds) polling.push_back({fd, POLLIN, 0});
        if (poll(polling.data(), polling.size(), std::min(wait_ms, 200U)) < 0 && errno != EINTR)
            throw std::runtime_error("Cannot wait for Mosh socket");
        return 0;
    } catch (const std::exception& e) { error_text(error, capacity, e.what()); }
    catch (...) { error_text(error, capacity, "Mosh socket wait failed"); }
    return -1;
}
extern "C" int lazysh_mosh_copy(void* pointer, unsigned char* buffer, size_t length) noexcept {
    auto& output = static_cast<Client*>(pointer)->output;
    if (length != output.size()) return -1;
    if (length) std::memcpy(buffer, output.data(), length);
    return 0;
}
extern "C" int lazysh_mosh_shutdown(void* pointer, char* error, size_t capacity) noexcept {
    return boundary([&] { static_cast<Client*>(pointer)->network->start_shutdown(); }, error, capacity);
}
extern "C" void lazysh_mosh_free(void* pointer) noexcept {
    delete static_cast<Client*>(pointer);
}
extern "C" int lazysh_mosh_validate(const unsigned char* data, size_t length, char* error, size_t capacity) noexcept {
    return boundary([&] {
        if (length > 4 * 1024 * 1024) throw std::runtime_error("Mosh state exceeds 4 MiB");
        Terminal::Complete state(80, 24);
        state.apply_string(std::string(reinterpret_cast<const char*>(data), length));
    }, error, capacity);
}
extern "C" uint64_t lazysh_mosh_test_state_num(void* pointer) noexcept {
    return static_cast<Client*>(pointer)->network->get_remote_state_num();
}
extern "C" void lazysh_mosh_test_set_errno(int value) noexcept { errno = value; }
extern "C" size_t lazysh_mosh_test_receive_mtu() noexcept { return Crypto::Session::RECEIVE_MTU; }

// Only referenced by Rust's cfg(test) fixtures; all packets use an ephemeral public test key.
extern "C" int lazysh_mosh_test_packet(int instruction, uint64_t old_num, uint64_t new_num, uint64_t throwaway,
                                        const unsigned char* data, size_t length, unsigned char* output, size_t capacity,
                                        size_t* written, char* error, size_t error_capacity) noexcept {
    return boundary([&] {
        if (length > 512) throw std::runtime_error("Test packet is too large");
        std::string payload(reinterpret_cast<const char*>(data), length);
        if (instruction) {
            TransportBuffers::Instruction value;
            value.set_protocol_version(2);
            value.set_old_num(old_num); value.set_new_num(new_num); value.set_ack_num(0); value.set_throwaway_num(throwaway);
            value.set_diff(payload);
            Network::Fragmenter fragments;
            auto packets = fragments.make_fragments(value, 1200);
            if (packets.size() != 1) throw std::runtime_error("Test packet must fit one datagram");
            payload = packets[0].tostring();
        }
        Crypto::Session encryption{Crypto::Base64Key("AAAAAAAAAAAAAAAAAAAAAA")};
        Network::Packet packet(Network::TO_CLIENT, 65535, 65535, payload);
        auto ciphertext = encryption.encrypt(packet.toMessage());
        if (ciphertext.size() > capacity) throw std::runtime_error("Test packet buffer is too small");
        std::memcpy(output, ciphertext.data(), ciphertext.size());
        *written = ciphertext.size();
    }, error, error_capacity);
}

#ifdef LAZYSH_MOSH_TEST_FIXTURES
// Development-only authenticated ACK observer for the fixed public fixture key.
extern "C" int lazysh_mosh_test_ack(const unsigned char* bytes, size_t length, uint64_t* ack,
                                     char* error, size_t capacity) noexcept {
    return boundary([&] {
        if (length > 2048) throw std::runtime_error("Test packet is too large");
        Crypto::Session encryption{Crypto::Base64Key("AAAAAAAAAAAAAAAAAAAAAA")};
        Network::Packet packet(encryption.decrypt(reinterpret_cast<const char*>(bytes), length));
        if (packet.direction != Network::TO_SERVER) throw std::runtime_error("Unexpected fixture direction");
        Network::Fragment fragment(packet.payload);
        if (fragment.fragment_num != 0 || !fragment.final) throw std::runtime_error("Fixture ACK must fit one fragment");
        TransportBuffers::Instruction instruction;
        if (!instruction.ParseFromString(Network::get_compressor().uncompress_str(fragment.contents)))
            throw std::runtime_error("Invalid fixture instruction");
        *ack = instruction.ack_num();
    }, error, capacity);
}
#endif

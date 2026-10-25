#include "bridge.h"
#include <cmath>
#include <cstring>
#include <memory>
#include <new>
#include "nlohmann/json.hpp"
#include "sherpa-onnx/c-api/c-api.h"

namespace {
template <typename T, void (*Destroy)(const T *)> struct SafeDelete {
  void operator()(const T *value) const noexcept {
    if (value) { try { Destroy(value); } catch (...) {} }
  }
};
template <typename T, void (*Destroy)(const T *)>
using Owned = std::unique_ptr<const T, SafeDelete<T, Destroy>>;
using Model = Owned<SherpaOnnxOfflineRecognizer, SherpaOnnxDestroyOfflineRecognizer>;
using Stream = Owned<SherpaOnnxOfflineStream, SherpaOnnxDestroyOfflineStream>;
using Result = Owned<char, SherpaOnnxDestroyOfflineStreamResultJson>;
}
struct LazyshParakeet { Model model; };

extern "C" const char *lazysh_parakeet_version() noexcept {
  try { return SherpaOnnxGetVersionStr(); } catch (...) { return nullptr; }
}
extern "C" int lazysh_parakeet_create(const char *encoder, const char *decoder,
                                     const char *joiner, const char *tokens,
                                     LazyshParakeet **out) noexcept {
  if (!out) return LAZYSH_PARAKEET_INVALID;
  *out = nullptr;
  if (!encoder || !decoder || !joiner || !tokens) return LAZYSH_PARAKEET_INVALID;
  try {
    SherpaOnnxOfflineRecognizerConfig config{};
    config.feat_config.sample_rate = 16000;
    config.model_config.transducer.encoder = encoder;
    config.model_config.transducer.decoder = decoder;
    config.model_config.transducer.joiner = joiner;
    config.model_config.tokens = tokens;
    config.model_config.model_type = "nemo_transducer";
    config.model_config.provider = "cpu";
    config.model_config.num_threads = 2;
    config.model_config.debug = 0;
    config.decoding_method = "greedy_search";
    Model model(SherpaOnnxCreateOfflineRecognizer(&config));
    if (!model) return LAZYSH_PARAKEET_LIBRARY;
    auto engine = std::make_unique<LazyshParakeet>();
    engine->model = std::move(model);
    *out = engine.release();
    return LAZYSH_PARAKEET_OK;
  } catch (...) { return LAZYSH_PARAKEET_LIBRARY; }
}
extern "C" int lazysh_parakeet_transcribe(LazyshParakeet *engine,
                                         const float *samples, int32_t count,
                                         char *out, size_t capacity,
                                         size_t *written) noexcept {
  if (written) *written = 0;
  if (out && capacity) out[0] = '\0';
  if (!engine || !samples || count < 1600 || count > 480000 || !out ||
      capacity < 2 || capacity > 65537 || !written) return LAZYSH_PARAKEET_INVALID;
  for (int32_t i = 0; i < count; ++i)
    if (!std::isfinite(samples[i]) || std::abs(samples[i]) > 1.f)
      return LAZYSH_PARAKEET_INVALID;
  try {
    Stream stream(SherpaOnnxCreateOfflineStream(engine->model.get()));
    if (!stream) return LAZYSH_PARAKEET_LIBRARY;
    SherpaOnnxAcceptWaveformOffline(stream.get(), 16000, samples, count);
    SherpaOnnxDecodeOfflineStream(engine->model.get(), stream.get());
    // The full snapshot C API can leak partially allocated token arrays on exceptions.
    // Its JSON API uses one returned allocation, paired with its dedicated destructor.
    Result result(SherpaOnnxGetOfflineStreamResultAsJson(stream.get()));
    if (!result) return LAZYSH_PARAKEET_LIBRARY;
    constexpr size_t maximum_json = 4 * 1024 * 1024;
    size_t length = 0;
    while (length <= maximum_json && result.get()[length] != '\0') ++length;
    if (length > maximum_json) return LAZYSH_PARAKEET_OUTPUT_LIMIT;
    const auto json = nlohmann::json::parse(result.get(), result.get() + length);
    const auto &text = json.at("text").get_ref<const std::string &>();
    if (text.size() >= capacity) return LAZYSH_PARAKEET_OUTPUT_LIMIT;
    std::memcpy(out, text.data(), text.size()); out[text.size()] = '\0';
    *written = text.size();
    return LAZYSH_PARAKEET_OK;
  } catch (...) { return LAZYSH_PARAKEET_LIBRARY; }
}
extern "C" void lazysh_parakeet_destroy(LazyshParakeet *engine) noexcept {
  try { delete engine; } catch (...) {}
}

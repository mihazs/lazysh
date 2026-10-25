#include <regex>
#include "onnxruntime_c_api.h"

#ifdef LAZYSH_EXPECTED_GLIBCXX_ABI
#if !defined(__GLIBCXX__)
#error "The pinned Linux ORT static archive requires matching libstdc++"
#endif
static_assert(_GLIBCXX_USE_CXX11_ABI == LAZYSH_EXPECTED_GLIBCXX_ABI,
              "Match the pinned Linux architecture's libstdc++ string ABI");
#endif

// No model or speech is needed: exercise the real ORT startup path together with
// local std::regex instantiations, where incompatible static C++ ABIs can collide.
int main() {
  const std::regex version("^[0-9]+\\.[0-9]+$");
  if (!std::regex_match("1.28", version)) return 1;
  const OrtApi *api = OrtGetApiBase()->GetApi(ORT_API_VERSION);
  if (!api) return 2;
  OrtEnv *environment = nullptr;
  OrtStatus *status = api->CreateEnv(ORT_LOGGING_LEVEL_ERROR, "lazysh-native-test", &environment);
  if (status) { api->ReleaseStatus(status); return 3; }
  if (!environment) return 4;
  api->ReleaseEnv(environment);
  return std::regex_match("1.28", version) ? 0 : 5;
}

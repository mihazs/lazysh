#include "bridge.h"
#include "sherpa-onnx/c-api/c-api.h"
#include "nlohmann/json.hpp"
#include <cstring>
#include <iostream>
#include <limits>
#include <new>
#include <stdexcept>
#include <string>
#include <vector>

// Test-only implementations of the public C API, never linked into the production archive.
struct SherpaOnnxOfflineRecognizer {};
struct SherpaOnnxOfflineStream {};
namespace {
int models = 0, streams = 0, results = 0, calls = 0, failure = 0;
bool allocation_failure = false, cleanup_failure = false, null_result = false, null_text = false, malformed_json = false;
std::string payload = "hello", destruction;
void check(bool valid) { if (!valid) throw std::runtime_error("native boundary assertion failed"); }
void stage(int value) { ++calls; if (failure == value) { if (allocation_failure) throw std::bad_alloc(); throw std::runtime_error("synthetic native exception"); } }
void clean() { if (cleanup_failure) throw std::runtime_error("synthetic cleanup exception"); }
}
extern "C" const char *SherpaOnnxGetVersionStr() { stage(6); return "2.0.0"; }
extern "C" const SherpaOnnxOfflineRecognizer *SherpaOnnxCreateOfflineRecognizer(const SherpaOnnxOfflineRecognizerConfig *config) {
  stage(1); check(std::strcmp(config->model_config.provider,"cpu")==0);
  check(config->model_config.num_threads==2 && config->model_config.debug==0);
  check(std::strcmp(config->model_config.model_type,"nemo_transducer")==0);
  ++models; return new SherpaOnnxOfflineRecognizer;
}
extern "C" void SherpaOnnxDestroyOfflineRecognizer(const SherpaOnnxOfflineRecognizer *value) {
  delete value; --models; destruction+='M'; clean();
}
extern "C" const SherpaOnnxOfflineStream *SherpaOnnxCreateOfflineStream(const SherpaOnnxOfflineRecognizer *) {
  stage(2); ++streams; return new SherpaOnnxOfflineStream;
}
extern "C" void SherpaOnnxDestroyOfflineStream(const SherpaOnnxOfflineStream *value) {
  delete value; --streams; destruction+='S'; clean();
}
extern "C" void SherpaOnnxAcceptWaveformOffline(const SherpaOnnxOfflineStream *,int32_t rate,const float *,int32_t) {check(rate==16000);stage(3);}
extern "C" void SherpaOnnxDecodeOfflineStream(const SherpaOnnxOfflineRecognizer *,const SherpaOnnxOfflineStream *) {stage(4);}
extern "C" const char *SherpaOnnxGetOfflineStreamResultAsJson(const SherpaOnnxOfflineStream *) {
  stage(5); if(null_result)return nullptr;
  const auto json=malformed_json?std::string("{"):(null_text?nlohmann::json({{"text",nullptr}}):nlohmann::json({{"text",payload}})).dump();
  auto *result=new char[json.size()+1];std::memcpy(result,json.c_str(),json.size()+1);
  ++results;return result;
}
extern "C" void SherpaOnnxDestroyOfflineStreamResultJson(const char *value) {
  delete[] value;--results;destruction+='R';clean();
}
int main() {
  try {
    std::vector<float> samples(1600,0.f);
    for(bool allocation:{false,true})for(int fail=1;fail<=5;++fail){
      allocation_failure=allocation;failure=fail;LazyshParakeet *engine=nullptr;
      const int created=lazysh_parakeet_create("encoder","decoder","joiner","tokens",&engine);
      if(fail==1){check(created==LAZYSH_PARAKEET_LIBRARY && !engine);}
      else{
        check(created==0 && engine);char text[16];size_t written=999;
        check(lazysh_parakeet_transcribe(engine,samples.data(),1600,text,sizeof(text),&written)==LAZYSH_PARAKEET_LIBRARY);
        check(written==0 && text[0]=='\0');lazysh_parakeet_destroy(engine);
      }
      check(models==0 && streams==0 && results==0);
    }
    failure=0;allocation_failure=false;LazyshParakeet *engine=nullptr;
    check(lazysh_parakeet_create("encoder","decoder","joiner","tokens",&engine)==0);
    payload="abc";char guarded[5]={'?','?','?','?','X'};size_t written=999;
    check(lazysh_parakeet_transcribe(engine,samples.data(),1600,guarded,3,&written)==LAZYSH_PARAKEET_OUTPUT_LIMIT);
    check(written==0 && guarded[0]=='\0' && guarded[4]=='X');
    check(lazysh_parakeet_transcribe(engine,samples.data(),1600,guarded,4,&written)==0);
    check(written==3 && std::strcmp(guarded,"abc")==0 && guarded[4]=='X');
    for(int count:{0,1599,480001}){
      const int before=calls;
      check(lazysh_parakeet_transcribe(engine,samples.data(),count,guarded,4,&written)==LAZYSH_PARAKEET_INVALID);check(before==calls);
    }
    samples[0]=std::numeric_limits<float>::quiet_NaN();const int before=calls;
    check(lazysh_parakeet_transcribe(engine,samples.data(),1600,guarded,4,&written)==LAZYSH_PARAKEET_INVALID);check(before==calls);samples[0]=0;
    null_result=true;check(lazysh_parakeet_transcribe(engine,samples.data(),1600,guarded,4,&written)==LAZYSH_PARAKEET_LIBRARY);null_result=false;
    null_text=true;check(lazysh_parakeet_transcribe(engine,samples.data(),1600,guarded,4,&written)==LAZYSH_PARAKEET_LIBRARY);null_text=false;
    malformed_json=true;check(lazysh_parakeet_transcribe(engine,samples.data(),1600,guarded,4,&written)==LAZYSH_PARAKEET_LIBRARY);malformed_json=false;
    for(size_t capacity:{size_t(0),size_t(1),size_t(65538),std::numeric_limits<size_t>::max()}){
      const int count=calls;check(lazysh_parakeet_transcribe(engine,samples.data(),1600,guarded,capacity,&written)==LAZYSH_PARAKEET_INVALID);check(calls==count);
    }
    payload=std::string(4*1024*1024,'x');check(lazysh_parakeet_transcribe(engine,samples.data(),1600,guarded,4,&written)==LAZYSH_PARAKEET_OUTPUT_LIMIT);
    payload="世界";char unicode[7];check(lazysh_parakeet_transcribe(engine,samples.data(),1600,unicode,sizeof(unicode),&written)==0);check(written==6);
    payload=std::string("a\0b",3);check(lazysh_parakeet_transcribe(engine,samples.data(),1600,guarded,4,&written)==0);check(written==3 && guarded[1]=='\0' && guarded[2]=='b');
    payload="abc";
    cleanup_failure=true;destruction.clear();
    check(lazysh_parakeet_transcribe(engine,samples.data(),1600,guarded,4,&written)==0);
    lazysh_parakeet_destroy(engine);check(destruction=="RSM");
    check(models==0 && streams==0 && results==0);
    failure=6;check(lazysh_parakeet_version()==nullptr);failure=0;cleanup_failure=false;
    check(lazysh_parakeet_create(nullptr,"decoder","joiner","tokens",&engine)==LAZYSH_PARAKEET_INVALID && !engine);
    lazysh_parakeet_destroy(nullptr);
    return 0;
  }catch(const std::exception &error){std::cerr<<error.what()<<'\n';return 1;}
}

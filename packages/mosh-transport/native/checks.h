#pragma once
#include <stdexcept>
#define lazysh_assert(condition) ((condition) ? (void)0 : throw std::runtime_error("Mosh core rejected invalid state"))

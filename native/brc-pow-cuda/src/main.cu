#include <cuda_runtime.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

static constexpr uint32_t SANDGLASS_FORK_HEIGHT = 33550;
static constexpr int HEADER_LEN = 148;
static constexpr int OUT_LEN = 32;
static constexpr int NONCE_OFFSET = 112;
static constexpr int SG_W = 1 << 17;
static constexpr uint32_t SG_MASK = SG_W - 1;
static constexpr int SG_PER = (1 << 21) / 4;
static constexpr uint32_t GOLDEN = 0x9e3779b9u;
static constexpr int DEFAULT_LANES = 1024;
static constexpr int DEFAULT_NONCES_PER_LANE = 16;

__constant__ uint8_t c_header[HEADER_LEN];
__constant__ uint8_t c_target[OUT_LEN];

struct Hit {
  uint32_t nonce;
  uint8_t hash[OUT_LEN];
};

__host__ __device__ static inline uint32_t rotr32(uint32_t x, uint32_t n) {
  return (x >> n) | (x << (32 - n));
}

__device__ static inline uint32_t sg_mix(uint32_t x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}

__device__ static inline uint32_t read_u32be(const uint8_t* b, int off) {
  return ((uint32_t)b[off] << 24) | ((uint32_t)b[off + 1] << 16) | ((uint32_t)b[off + 2] << 8) | b[off + 3];
}

__device__ static inline void write_u32be(uint8_t* b, int off, uint32_t v) {
  b[off] = (uint8_t)(v >> 24);
  b[off + 1] = (uint8_t)(v >> 16);
  b[off + 2] = (uint8_t)(v >> 8);
  b[off + 3] = (uint8_t)v;
}

__device__ static inline bool hash_lt_target(const uint8_t* hash) {
  for (int i = 0; i < OUT_LEN; i++) {
    if (hash[i] != c_target[i]) return hash[i] < c_target[i];
  }
  return false;
}

__device__ static void sha256_one(const uint8_t* msg, int len, uint8_t out[32]) {
  static constexpr uint32_t K[64] = {
    0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
    0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
    0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
    0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
    0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
    0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
    0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
    0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
  };
  uint32_t h0 = 0x6a09e667u, h1 = 0xbb67ae85u, h2 = 0x3c6ef372u, h3 = 0xa54ff53au;
  uint32_t h4 = 0x510e527fu, h5 = 0x9b05688cu, h6 = 0x1f83d9abu, h7 = 0x5be0cd19u;
  const int total = ((len + 9 + 63) / 64) * 64;
  for (int chunk = 0; chunk < total; chunk += 64) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
      uint32_t v = 0;
      for (int j = 0; j < 4; j++) {
        int p = chunk + i * 4 + j;
        uint8_t byte = 0;
        if (p < len) byte = msg[p];
        else if (p == len) byte = 0x80;
        else if (p >= total - 8) {
          uint64_t bits = (uint64_t)len * 8u;
          byte = (uint8_t)(bits >> (8 * (total - 1 - p)));
        }
        v = (v << 8) | byte;
      }
      w[i] = v;
    }
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (int i = 0; i < 64; i++) {
      uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      uint32_t ch = (e & f) ^ ((~e) & g);
      uint32_t temp1 = h + S1 + ch + K[i] + w[i];
      uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t temp2 = S0 + maj;
      h = g; g = f; f = e; e = d + temp1; d = c; c = b; b = a; a = temp1 + temp2;
    }
    h0 += a; h1 += b; h2 += c; h3 += d; h4 += e; h5 += f; h6 += g; h7 += h;
  }
  uint32_t hs[8] = { h0, h1, h2, h3, h4, h5, h6, h7 };
  for (int i = 0; i < 8; i++) write_u32be(out, i * 4, hs[i]);
}

__device__ static void sandglass_hash(const uint8_t header[HEADER_LEN], uint32_t* buf, uint8_t out[OUT_LEN]) {
  uint8_t seed[32];
  sha256_one(header, HEADER_LEN, seed);
  uint32_t sw[8];
  for (int i = 0; i < 8; i++) sw[i] = read_u32be(seed, i * 4);
  uint32_t h = sg_mix(sw[0] ^ GOLDEN);
  for (int i = 0; i < SG_W; i++) {
    h = sg_mix(h + GOLDEN + sw[i & 7]);
    buf[i] = h;
  }
  uint32_t x = h;
  x = sg_mix(x ^ 1u); uint32_t a0 = sg_mix(x ^ GOLDEN); uint32_t i0 = x & SG_MASK;
  x = sg_mix(x ^ 2u); uint32_t a1 = sg_mix(x ^ GOLDEN); uint32_t i1 = x & SG_MASK;
  x = sg_mix(x ^ 3u); uint32_t a2 = sg_mix(x ^ GOLDEN); uint32_t i2 = x & SG_MASK;
  x = sg_mix(x ^ 4u); uint32_t a3 = sg_mix(x ^ GOLDEN); uint32_t i3 = x & SG_MASK;
  for (uint32_t s = 0; s < (uint32_t)SG_PER; s++) {
    a0 = sg_mix(a0 ^ buf[i0]); buf[i0] = a0 + s; i0 = a0 & SG_MASK;
    a1 = sg_mix(a1 ^ buf[i1]); buf[i1] = a1 + s; i1 = a1 & SG_MASK;
    a2 = sg_mix(a2 ^ buf[i2]); buf[i2] = a2 + s; i2 = a2 & SG_MASK;
    a3 = sg_mix(a3 ^ buf[i3]); buf[i3] = a3 + s; i3 = a3 & SG_MASK;
  }
  uint8_t fin[52];
  for (int i = 0; i < 32; i++) fin[i] = seed[i];
  write_u32be(fin, 32, h); write_u32be(fin, 36, a0); write_u32be(fin, 40, a1);
  write_u32be(fin, 44, a2); write_u32be(fin, 48, a3);
  sha256_one(fin, 52, out);
}

__global__ void grind_kernel(uint64_t start, uint64_t end, int lanes, int nonces_per_lane, uint32_t* scratch, int* found_count, Hit* hits, uint64_t* hashes_done) {
  int lane = blockIdx.x * blockDim.x + threadIdx.x;
  int total = gridDim.x * blockDim.x;
  if (lane >= lanes) return;
  uint8_t header[HEADER_LEN];
  for (int i = 0; i < HEADER_LEN; i++) header[i] = c_header[i];
  uint32_t* buf = scratch + ((size_t)lane * SG_W);
  uint64_t local = 0;
  uint64_t nonce = start + lane;
  for (int n = 0; n < nonces_per_lane && nonce < end; n++, nonce += total) {
    write_u32be(header, NONCE_OFFSET, (uint32_t)nonce);
    uint8_t hash[OUT_LEN];
    sandglass_hash(header, buf, hash);
    local++;
    if (hash_lt_target(hash)) {
      int slot = atomicAdd(found_count, 1);
      if (slot < 64) {
        hits[slot].nonce = (uint32_t)nonce;
        for (int i = 0; i < OUT_LEN; i++) hits[slot].hash[i] = hash[i];
      }
    }
  }
  atomicAdd((unsigned long long*)hashes_done, (unsigned long long)local);
}

static void fail(const std::string& msg, int code = 1) {
  std::cerr << "error: " << msg << "\n";
  std::exit(code);
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static std::vector<uint8_t> decode_hex(const std::string& hex) {
  if (hex.size() % 2) fail("invalid hex length");
  std::vector<uint8_t> out(hex.size() / 2);
  for (size_t i = 0; i < out.size(); i++) {
    int a = hexval(hex[i * 2]);
    int b = hexval(hex[i * 2 + 1]);
    if (a < 0 || b < 0) fail("invalid hex char");
    out[i] = (uint8_t)((a << 4) | b);
  }
  return out;
}

static std::string to_hex(const uint8_t* bytes, int len) {
  static const char* h = "0123456789abcdef";
  std::string s;
  s.reserve((size_t)len * 2);
  for (int i = 0; i < len; i++) {
    s.push_back(h[bytes[i] >> 4]);
    s.push_back(h[bytes[i] & 15]);
  }
  return s;
}

static uint32_t host_height(const std::vector<uint8_t>& h) {
  return ((uint32_t)h[0] << 24) | ((uint32_t)h[1] << 16) | ((uint32_t)h[2] << 8) | h[3];
}

static void cuda_check(cudaError_t e, const char* what) {
  if (e != cudaSuccess) fail(std::string(what) + ": " + cudaGetErrorString(e));
}

static int grind(int argc, char** argv) {
  if (argc != 7 && argc != 8 && argc != 9 && argc != 10) {
    fail("usage: brc-pow-cuda grind <header-hex> <target-hex> <start> <end> <throttle> [continuous] [lanes] [nonces_per_lane]", 2);
  }
  auto header = decode_hex(argv[2]);
  auto target = decode_hex(argv[3]);
  if (header.size() != HEADER_LEN) fail("header must be 148 bytes");
  if (target.size() != OUT_LEN) fail("target must be 32 bytes");
  if (host_height(header) < SANDGLASS_FORK_HEIGHT) {
    fail("CUDA grinder supports Sandglass-era mining only");
  }
  uint64_t start = std::stoull(argv[4]);
  uint64_t end = std::stoull(argv[5]);
  double throttle = std::stod(argv[6]);
  bool continuous = argc >= 8 && (std::string(argv[7]) == "1" || std::string(argv[7]) == "true");
  int lanes = argc >= 9 ? std::max(1, std::stoi(argv[8])) : DEFAULT_LANES;
  int nonces_per_lane = argc >= 10 ? std::max(1, std::stoi(argv[9])) : DEFAULT_NONCES_PER_LANE;
  int threads = 128;
  int blocks = (lanes + threads - 1) / threads;
  size_t scratch_words = (size_t)lanes * SG_W;
  uint32_t* d_scratch = nullptr;
  int* d_found_count = nullptr;
  Hit* d_hits = nullptr;
  uint64_t* d_hashes = nullptr;
  std::vector<Hit> hits(64);
  int found_count = 0;
  uint64_t hashes_total = 0;
  uint64_t hashes_last = 0;
  cuda_check(cudaMemcpyToSymbol(c_header, header.data(), HEADER_LEN), "copy header");
  cuda_check(cudaMemcpyToSymbol(c_target, target.data(), OUT_LEN), "copy target");
  cuda_check(cudaMalloc(&d_scratch, scratch_words * sizeof(uint32_t)), "alloc scratch");
  cuda_check(cudaMalloc(&d_found_count, sizeof(int)), "alloc found count");
  cuda_check(cudaMalloc(&d_hits, hits.size() * sizeof(Hit)), "alloc hits");
  cuda_check(cudaMalloc(&d_hashes, sizeof(uint64_t)), "alloc hash counter");
  cuda_check(cudaMemset(d_hashes, 0, sizeof(uint64_t)), "clear hash counter");
  auto last_report = std::chrono::steady_clock::now();
  uint64_t cursor = start;
  while (cursor < end) {
    cuda_check(cudaMemset(d_found_count, 0, sizeof(int)), "clear found count");
    uint64_t span = (uint64_t)lanes * (uint64_t)nonces_per_lane;
    uint64_t chunk_end = std::min(end, cursor + span);
    auto t0 = std::chrono::steady_clock::now();
    grind_kernel<<<blocks, threads>>>(cursor, chunk_end, lanes, nonces_per_lane, d_scratch, d_found_count, d_hits, d_hashes);
    cuda_check(cudaGetLastError(), "launch");
    cuda_check(cudaDeviceSynchronize(), "sync");
    cuda_check(cudaMemcpy(&found_count, d_found_count, sizeof(int), cudaMemcpyDeviceToHost), "copy found count");
    int copy_count = std::min(found_count, (int)hits.size());
    if (copy_count > 0) {
      cuda_check(cudaMemcpy(hits.data(), d_hits, (size_t)copy_count * sizeof(Hit), cudaMemcpyDeviceToHost), "copy hits");
      for (int i = 0; i < copy_count; i++) {
        std::cout << "SOLVED " << hits[i].nonce << " " << to_hex(hits[i].hash, OUT_LEN) << "\n";
      }
      std::cout.flush();
      if (!continuous) break;
    }
    cursor = chunk_end;
    uint64_t done = 0;
    cuda_check(cudaMemcpy(&done, d_hashes, sizeof(uint64_t), cudaMemcpyDeviceToHost), "copy hash counter");
    hashes_total = done;
    auto now = std::chrono::steady_clock::now();
    if (now - last_report >= std::chrono::seconds(1)) {
      std::cerr << "HASHRATE " << (hashes_total - hashes_last) << "\n";
      hashes_last = hashes_total;
      last_report = now;
    }
    if (throttle < 1.0) {
      auto work = std::chrono::steady_clock::now() - t0;
      double work_ms = std::chrono::duration<double, std::milli>(work).count();
      double sleep_ms = std::min(1000.0, work_ms * (1.0 - throttle) / std::max(0.05, throttle));
      if (sleep_ms >= 1.0) std::this_thread::sleep_for(std::chrono::duration<double, std::milli>(sleep_ms));
    }
  }
  if (cursor >= end) std::cout << "EXHAUSTED\n";
  cudaFree(d_hashes);
  cudaFree(d_hits);
  cudaFree(d_found_count);
  cudaFree(d_scratch);
  return 0;
}

int main(int argc, char** argv) {
  if (argc < 2) fail("usage: brc-pow-cuda grind ...", 2);
  std::string cmd = argv[1];
  if (cmd == "grind") return grind(argc, argv);
  fail("unknown subcommand: " + cmd, 2);
}

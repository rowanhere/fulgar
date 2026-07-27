NVCC ?= nvcc
BUILD_DIR ?= target/release
BIN := $(BUILD_DIR)/brc-pow-cuda

NVCCFLAGS ?= -O3 -std=c++17

.PHONY: all clean

all: $(BIN)

$(BIN): src/main.cu
	mkdir -p $(BUILD_DIR)
	$(NVCC) $(NVCCFLAGS) -o $(BIN) src/main.cu

clean:
	rm -rf target

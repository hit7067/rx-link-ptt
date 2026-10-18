#include "opendmr.h"
#include <cstdint>
#include <cstdio>
#include <cstring>

// Stream PCM S16LE mono at 8 kHz in 20 ms frames to 9-byte AMBE+2 frames.
// stdout is binary-only; diagnostics go to stderr.
int main() {
    opendmr_encoder_t *enc = opendmr_encoder_create();
    if (!enc) return 2;
    uint8_t raw[320];
    int16_t pcm[160];
    uint8_t ambe[9];
    while (true) {
        size_t n = std::fread(raw, 1, sizeof(raw), stdin);
        if (n == 0) break;
        if (n != sizeof(raw)) {
            std::fprintf(stderr, "incomplete PCM frame: %zu bytes\n", n);
            break;
        }
        for (int i = 0; i < 160; ++i) {
            pcm[i] = static_cast<int16_t>(static_cast<uint16_t>(raw[i * 2]) |
                    (static_cast<uint16_t>(raw[i * 2 + 1]) << 8));
        }
        if (!opendmr_encode(enc, pcm, ambe)) {
            std::fprintf(stderr, "AMBE encoding failed\n");
            opendmr_encoder_destroy(enc);
            return 3;
        }
        if (std::fwrite(ambe, 1, sizeof(ambe), stdout) != sizeof(ambe)) {
            opendmr_encoder_destroy(enc);
            return 4;
        }
        std::fflush(stdout);
    }
    opendmr_encoder_destroy(enc);
    return 0;
}

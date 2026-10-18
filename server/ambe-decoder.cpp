#include "opendmr.h"
#include <cstdint>
#include <cstdio>

// Read packed 9-byte AMBE+2 frames from stdin and emit 160-sample PCM S16LE
// frames (320 bytes) at 8 kHz to stdout.
int main() {
    opendmr_decoder_t *dec = opendmr_decoder_create();
    if (!dec) return 2;
    uint8_t ambe[9];
    int16_t pcm[160];
    while (true) {
        size_t n = std::fread(ambe, 1, sizeof(ambe), stdin);
        if (n == 0) break;
        if (n != sizeof(ambe)) {
            std::fprintf(stderr, "incomplete AMBE frame: %zu bytes\n", n);
            break;
        }
        int errs = 0;
        if (!opendmr_decode(dec, ambe, pcm, &errs)) {
            std::fprintf(stderr, "AMBE decoding failed\n");
            continue;
        }
        uint8_t raw[320];
        for (int i = 0; i < 160; ++i) {
            uint16_t sample = static_cast<uint16_t>(pcm[i]);
            raw[i * 2] = static_cast<uint8_t>(sample & 0xff);
            raw[i * 2 + 1] = static_cast<uint8_t>((sample >> 8) & 0xff);
        }
        if (std::fwrite(raw, 1, sizeof(raw), stdout) != sizeof(raw)) {
            opendmr_decoder_destroy(dec);
            return 4;
        }
        std::fflush(stdout);
    }
    opendmr_decoder_destroy(dec);
    return 0;
}

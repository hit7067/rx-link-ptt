#include "opendmr.h"
#include <cstdint>
#include <cstdio>
#include <cstring>

// Default: PCM S16LE mono at 8 kHz -> 9-byte AMBE+2 frames.
// --decode: 9-byte AMBE+2 frames -> PCM S16LE mono at 8 kHz.
// stdin/stdout are binary-only; diagnostics go to stderr.
static int encode_stream() {
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
static int decode_stream() {
    opendmr_decoder_t *dec = opendmr_decoder_create();
    if (!dec) return 2;
    uint8_t ambe[9];
    int16_t pcm[160];
    uint8_t raw[320];
    uint64_t decodedFrames = 0;
    uint64_t correctedBits = 0;
    while (true) {
        size_t n = std::fread(ambe, 1, sizeof(ambe), stdin);
        if (n == 0) break;
        if (n != sizeof(ambe)) {
            std::fprintf(stderr, "incomplete AMBE frame: %zu bytes\n", n);
            break;
        }
        int errs = 0;
        if (!opendmr_decode(dec, ambe, pcm, &errs)) {
            std::fprintf(stderr, "AMBE decoding failed at frame=%llu\n",
                         static_cast<unsigned long long>(decodedFrames + 1));
            continue;
        }
        decodedFrames++;
        correctedBits += static_cast<uint64_t>(errs);
        if (decodedFrames == 1 || decodedFrames % 500 == 0) {
            std::fprintf(stderr, "decode-stats frames=%llu correctedBits=%llu avgCorrectedBitsPerFrame=%.3f\n",
                         static_cast<unsigned long long>(decodedFrames),
                         static_cast<unsigned long long>(correctedBits),
                         static_cast<double>(correctedBits) / decodedFrames);
        }
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
int main(int argc, char **argv) {
    if (argc > 1 && std::strcmp(argv[1], "--decode") == 0) return decode_stream();
    return encode_stream();
}

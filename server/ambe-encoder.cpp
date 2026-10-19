#include "opendmr.h"
#include <cstdint>
#include <cstdio>
#include <cstring>

// RX link AMBE bridge.
//
// PCM contract: mono signed 16-bit little-endian, 8 kHz, 160 samples / 20 ms.
// ODTP 0x0920 contract: each AMBE+2 frame is 9 bytes in DMR interleaved order.
//
// OpenDMR's opendmr_encode()/opendmr_decode() bridge uses a canonical frame
// with the A, B and C FEC blocks stored consecutively. DMR air/network frames
// interleave those bits using the A/B/C tables below (same mapping used by
// DroidStar's MBEVocoder::encode_2450x1150). Passing canonical bytes directly
// to/from ODTP scrambles the codec frame even though its length is correct.
// Convert at the boundary in both directions; do not reverse bits within bytes.

static constexpr int A_TABLE[24] = {
    0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44,
    48, 52, 56, 60, 64, 68, 1, 5, 9, 13, 17, 21
};
static constexpr int B_TABLE[23] = {
    25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65, 69,
    2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42
};
static constexpr int C_TABLE[25] = {
    46, 50, 54, 58, 62, 66, 70, 3, 7, 11, 15, 19, 23,
    27, 31, 35, 39, 43, 47, 51, 55, 59, 63, 67, 71
};

static inline int get_bit(const uint8_t frame[9], int bit) {
    return (frame[bit >> 3] >> (7 - (bit & 7))) & 1;
}
static inline void set_bit(uint8_t frame[9], int bit, int value) {
    const uint8_t mask = static_cast<uint8_t>(1U << (7 - (bit & 7)));
    if (value) frame[bit >> 3] |= mask;
    else frame[bit >> 3] &= static_cast<uint8_t>(~mask);
}

static void canonical_to_dmr(const uint8_t canonical[9], uint8_t dmr[9]) {
    std::memset(dmr, 0, 9);
    for (int i = 0; i < 24; ++i) set_bit(dmr, A_TABLE[i], get_bit(canonical, i));
    for (int i = 0; i < 23; ++i) set_bit(dmr, B_TABLE[i], get_bit(canonical, 24 + i));
    for (int i = 0; i < 25; ++i) set_bit(dmr, C_TABLE[i], get_bit(canonical, 47 + i));
}
static void dmr_to_canonical(const uint8_t dmr[9], uint8_t canonical[9]) {
    std::memset(canonical, 0, 9);
    for (int i = 0; i < 24; ++i) set_bit(canonical, i, get_bit(dmr, A_TABLE[i]));
    for (int i = 0; i < 23; ++i) set_bit(canonical, 24 + i, get_bit(dmr, B_TABLE[i]));
    for (int i = 0; i < 25; ++i) set_bit(canonical, 47 + i, get_bit(dmr, C_TABLE[i]));
}

static int encode_stream() {
    opendmr_encoder_t *enc = opendmr_encoder_create();
    if (!enc) {
        std::fprintf(stderr, "AMBE encoder initialization failed\n");
        return 2;
    }
    uint8_t raw[320];
    int16_t pcm[160];
    uint8_t canonical[9];
    uint8_t dmr[9];
    uint64_t frames = 0;
    while (true) {
        const size_t n = std::fread(raw, 1, sizeof(raw), stdin);
        if (n == 0) break;
        if (n != sizeof(raw)) {
            std::fprintf(stderr, "incomplete PCM frame: %zu bytes (expected 320)\n", n);
            break;
        }
        for (int i = 0; i < 160; ++i) {
            pcm[i] = static_cast<int16_t>(static_cast<uint16_t>(raw[i * 2]) |
                    (static_cast<uint16_t>(raw[i * 2 + 1]) << 8));
        }
        if (!opendmr_encode(enc, pcm, canonical)) {
            std::fprintf(stderr, "AMBE encoding failed at frame=%llu\n",
                         static_cast<unsigned long long>(frames + 1));
            opendmr_encoder_destroy(enc);
            return 3;
        }
        canonical_to_dmr(canonical, dmr);
        if (std::fwrite(dmr, 1, sizeof(dmr), stdout) != sizeof(dmr)) {
            opendmr_encoder_destroy(enc);
            return 4;
        }
        ++frames;
        if (frames == 1 || frames % 500 == 0)
            std::fprintf(stderr, "encode-stats frames=%llu layout=DMR-ABC-interleaved\n",
                         static_cast<unsigned long long>(frames));
        std::fflush(stdout);
    }
    opendmr_encoder_destroy(enc);
    return 0;
}

static int decode_stream() {
    opendmr_decoder_t *dec = opendmr_decoder_create();
    if (!dec) {
        std::fprintf(stderr, "AMBE decoder initialization failed\n");
        return 2;
    }
    uint8_t dmr[9];
    uint8_t canonical[9];
    int16_t pcm[160];
    uint8_t raw[320];
    uint64_t decodedFrames = 0;
    uint64_t correctedBits = 0;
    while (true) {
        const size_t n = std::fread(dmr, 1, sizeof(dmr), stdin);
        if (n == 0) break;
        if (n != sizeof(dmr)) {
            std::fprintf(stderr, "incomplete AMBE frame: %zu bytes (expected 9)\n", n);
            break;
        }
        dmr_to_canonical(dmr, canonical);
        int errs = 0;
        if (!opendmr_decode(dec, canonical, pcm, &errs)) {
            std::fprintf(stderr, "AMBE decoding failed at frame=%llu\n",
                         static_cast<unsigned long long>(decodedFrames + 1));
            continue;
        }
        ++decodedFrames;
        correctedBits += static_cast<uint64_t>(errs);
        if (decodedFrames == 1 || decodedFrames % 500 == 0) {
            std::fprintf(stderr, "decode-stats frames=%llu correctedBits=%llu avgCorrectedBitsPerFrame=%.3f layout=DMR-ABC-interleaved\n",
                         static_cast<unsigned long long>(decodedFrames),
                         static_cast<unsigned long long>(correctedBits),
                         static_cast<double>(correctedBits) / decodedFrames);
        }
        for (int i = 0; i < 160; ++i) {
            const uint16_t sample = static_cast<uint16_t>(pcm[i]);
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

static bool test_frame_mapping() {
    uint8_t original[9];
    uint8_t dmr[9];
    uint8_t restored[9];
    for (int i = 0; i < 9; ++i) original[i] = static_cast<uint8_t>((i * 37 + 0x53) & 0xff);
    canonical_to_dmr(original, dmr);
    dmr_to_canonical(dmr, restored);
    return std::memcmp(original, restored, sizeof(original)) == 0;
}

int main(int argc, char **argv) {
    if (!test_frame_mapping()) {
        std::fprintf(stderr, "fatal: AMBE DMR interleave round-trip self-test failed\n");
        return 10;
    }
    if (argc > 1 && std::strcmp(argv[1], "--decode") == 0) return decode_stream();
    return encode_stream();
}

// The robot's camera picture as a JPEG, for the Live video on the iPhone (14 Nov 2026, owner: «prova a migliorare il
// video live da iPhone. Adesso è un 160x120, un fotogramma al secondo»). A raw 160×120 picture is 38 KB and the
// robot's link carries about 35 KB a second: one picture a second. As a JPEG the same picture is about 5 KB.
//
// The encoder is Espressif's esp_new_jpeg (already in the host: esp-dl brings it), which is why this file is compiled
// with the IDF project like face-dl.cpp (ROBOTTINO_MAIN_SOURCES) and hands its functions to face-finder.c at start.
// One encoder is kept open for the size in use (about 10 KB, asked from the external memory: the internal one is
// short) and closed when the video stops. Nothing is stored: the picture goes out and is forgotten.
#include <stdint.h>
#include <string.h>
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "sdkconfig.h"
#include "esp_jpeg_enc.h"
#include "esp_jpeg_dec.h"

void robottino_video_backend(int (*encode)(const uint8_t *, int, int, int, uint8_t *, int), void (*end)(void), int (*ms)(void));
void robottino_screen_backend(int (*decode)(const uint8_t *, int, int, uint8_t **, int *, int *), void (*end)(void));

static jpeg_enc_handle_t gEncoder;
static int gWidth, gHeight, gQuality, gMs;
static uint8_t *gAligned;   // the picture copied where the encoder wants it (16-byte aligned), when the camera's is not
static int gAlignedSize;

static void end(void)
{
    if (gEncoder) {
        jpeg_enc_close(gEncoder);
        gEncoder = NULL;
    }
    if (gAligned) {
        heap_caps_free(gAligned);
        gAligned = NULL;
    }
    gAlignedSize = gWidth = gHeight = gQuality = 0;
}

// RGB565 little endian, width*height*2 bytes, into out. Returns the JPEG's size, or a negative number: -1 bad
// arguments, -2 no memory, -3 the encoder refused, -4 it did not fit in out.
static int encode(const uint8_t *picture, int width, int height, int quality, uint8_t *out, int outSize)
{
    int size = 0, bytes = width * height * 2;
    int64_t from;
    if (!picture || !out || width < 16 || height < 16 || width > 320 || height > 240 || (width & 7) || (height & 7) || outSize < 1024)
        return -1;
    if (quality < 10) quality = 10;
    if (quality > 95) quality = 95;
    if (gEncoder && (gWidth != width || gHeight != height))
        end();
    if (!gEncoder) {
        jpeg_enc_config_t config = DEFAULT_JPEG_ENC_CONFIG();
        jpeg_error_t result;
        config.width = width;
        config.height = height;
        config.src_type = JPEG_PIXEL_FORMAT_RGB565_LE;
        config.subsampling = JPEG_SUBSAMPLE_420;
        config.quality = (uint8_t)quality;
        config.rotate = JPEG_ROTATE_0D;
        config.task_enable = false;
        // The encoder's own memory from the external RAM, as the face detector does (face-dl.cpp).
        heap_caps_malloc_extmem_enable(32);
        result = jpeg_enc_open(&config, &gEncoder);
        heap_caps_malloc_extmem_enable(CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL);
        if (JPEG_ERR_OK != result || !gEncoder) {
            gEncoder = NULL;
            return JPEG_ERR_NO_MEM == result ? -2 : -3;
        }
        gWidth = width;
        gHeight = height;
        gQuality = quality;
    }
    if (gQuality != quality) {
        if (JPEG_ERR_OK != jpeg_enc_set_quality(gEncoder, (uint8_t)quality))
            return -3;
        gQuality = quality;
    }
    if ((uintptr_t)picture & 15) {
        if (gAlignedSize < bytes) {
            if (gAligned) heap_caps_free(gAligned);
            gAligned = (uint8_t *)heap_caps_aligned_alloc(16, bytes, MALLOC_CAP_SPIRAM);
            gAlignedSize = gAligned ? bytes : 0;
            if (!gAligned) return -2;
        }
        memcpy(gAligned, picture, bytes);
        picture = gAligned;
    }
    from = esp_timer_get_time();
    {
        jpeg_error_t result = jpeg_enc_process(gEncoder, picture, bytes, out, outSize, &size);
        gMs = (int)((esp_timer_get_time() - from + 500) / 1000);
        if (JPEG_ERR_OK != result) {
            end(); // whatever state it is in, the next picture starts with a new encoder
            return JPEG_ERR_NO_MEM == result ? -4 : -3;
        }
    }
    if (size < 4 || size > outSize || out[0] != 0xFF || out[1] != 0xD8)
        return -3;
    return size;
}

static int ms(void) { return gMs; }

// The other way (14 Nov 2026, owner: «video all'avvio del robot»): one JPEG picture of the start-up video, kept in the
// MOD, made into screen pixels (RGB565, in the display's byte order) in one buffer of the external memory, kept from
// one picture to the next: JavaScript draws from it without a copy. The decoder's own memory (about 10 KB) lives only
// for one picture. Returns the size of the pixels, or a negative number: -1 bad
// arguments, -2 no memory, -3 the picture could not be read, -4 larger than SCREEN_MAX_PIXELS.
#define SCREEN_MAX_PIXELS (320 * 240)
static uint8_t *gScreen;
static int gScreenMs;

static void screenEnd(void)
{
    if (gScreen) {
        heap_caps_free(gScreen);
        gScreen = NULL;
    }
}

static int screenDecode(const uint8_t *jpeg, int length, int bigEndian, uint8_t **pixels, int *width, int *height)
{
    jpeg_dec_config_t config = DEFAULT_JPEG_DEC_CONFIG();
    jpeg_dec_handle_t decoder = NULL;
    jpeg_dec_io_t io;
    jpeg_dec_header_info_t info;
    jpeg_error_t result;
    int size = 0, answer;
    int64_t from = esp_timer_get_time();
    if (!jpeg || length < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 || !pixels || !width || !height)
        return -1;
    if (!gScreen) {
        gScreen = (uint8_t *)heap_caps_aligned_alloc(16, SCREEN_MAX_PIXELS * 2, MALLOC_CAP_SPIRAM);
        if (!gScreen) return -2;
    }
    config.output_type = bigEndian ? JPEG_PIXEL_FORMAT_RGB565_BE : JPEG_PIXEL_FORMAT_RGB565_LE;
    // The decoder's own memory (about 10 KB) where the system puts it: no change of the global limit of the external
    // memory here, because the face detector changes it too, from its own task, while it builds its networks.
    result = jpeg_dec_open(&config, &decoder);
    if (JPEG_ERR_OK != result || !decoder)
        return JPEG_ERR_NO_MEM == result ? -2 : -3;
    memset(&io, 0, sizeof(io));
    io.inbuf = (uint8_t *)jpeg;
    io.inbuf_len = length;
    answer = -3;
    if (JPEG_ERR_OK == jpeg_dec_parse_header(decoder, &io, &info)) {
        if (info.width < 1 || info.height < 1 || info.width * info.height > SCREEN_MAX_PIXELS)
            answer = -4;
        else if (JPEG_ERR_OK == jpeg_dec_get_outbuf_len(decoder, &size) && size == info.width * info.height * 2) {
            io.outbuf = gScreen;
            result = jpeg_dec_process(decoder, &io);
            if (JPEG_ERR_OK == result) {
                *pixels = gScreen;
                *width = info.width;
                *height = info.height;
                answer = size;
            }
        }
    }
    jpeg_dec_close(decoder);
    gScreenMs = (int)((esp_timer_get_time() - from + 500) / 1000);
    return answer;
}

int robottino_screen_ms(void) { return gScreenMs; }

// Called by face-dl.cpp when the host starts (that file is the one the linker is told to keep).
void robottino_video_offer(void)
{
    robottino_video_backend(encode, end, ms);
    robottino_screen_backend(screenDecode, screenEnd);
}

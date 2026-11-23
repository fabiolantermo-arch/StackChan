// The neural face detector of Espressif on the robot (13 Nov 2026): esp-dl with its human_face_detect models (MIT,
// github.com/espressif/esp-dl; two small networks made for the ESP32-S3, 190 KB). pico (picornt.c) found every test
// portrait and never the owner's real face in the camera's pictures (seen from below, glasses, the ceiling light
// behind), so the robot's own following needed a detector trained on real faces.
// It is C++ and an ESP-IDF component, so it cannot be an XS module: this file is compiled with the IDF project (the
// Moddable patch main-extra-sources.patch) and gives its two functions to face-finder.c when the program starts.
// The search runs in its own task, on whichever core is free: the robot's main task (JavaScript: voice, servos)
// only hands a copy of the picture over and asks later whether the answer is there.
#include "human_face_detect.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/idf_additions.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include <cstring>
#include <cstdio>

extern "C" {
void robottino_face_backend(int (*start)(const uint8_t *, int, int, int, int, int), int (*poll)(int16_t *), int (*info)(char *, int), int (*size)(int, int));
void robottino_video_offer(void); // video-jpeg.c: called below, so the linker keeps that file too
int robottino_main_sources = 1; // named on the link line, so this file is not left out
}

#define MAX_PIXELS (160 * 120)
#define TASK_STACK 12288
// The search has the second core to itself (the main task, with JavaScript, the network and the servos, is on the
// first: CONFIG_ESP_MAIN_TASK_AFFINITY_CPU0) and comes before the idle work there. Measured 13 Nov 2026 with no core
// of its own and the lowest priority: 213-246 ms a picture, against the 45 ms Espressif gives for these models.
#define TASK_CORE 1
#define TASK_PRIORITY 4
// The networks' working memory. Espressif's own classes (HumanFaceDetect) keep all of it in the external RAM, which
// on this robot is slow (quad; 40 MHz as upstream sets it, 80 MHz since 13 Nov 2026: patches/psram-80mhz.patch), and
// that is where the time goes. The same two networks are built here with part of that memory in the fast internal RAM: what is
// free there when the detector is first used, less INTERNAL_KEEP for the rest of the robot (network, TLS, drivers),
// at most INTERNAL_MOST. The first network (the whole picture) takes what it can use, the second the rest.
// The internal RAM is what the robot runs out of (13 Nov 2026: 45 KB free with the camera on, 30 KB once the
// detector was made; in the first conversation with following on the microphone's task could not be created and the
// host stopped on an assert in xs_audioin_start). So nothing of the detector stays there unless there is plenty:
// its task's stack is in the external RAM, and while the networks are made every allocation goes to the external RAM
// too (the small ones, lists and tables of esp-dl, would otherwise stay inside: 14 KB).
#define INTERNAL_KEEP (112 * 1024)
#define INTERNAL_MOST (224 * 1024)

extern const uint8_t human_face_detect_espdl[] asm("_binary_human_face_detect_espdl_start");
static const char *models = (const char *)human_face_detect_espdl;

// First network: the whole picture, at 160x120, gives up to ten places where a face may be (as human_face_detect::MSR).
class WholePicture : public dl::detect::DetectImpl {
public:
    // width, height: the size the network works at (0: its own, 160x120). The picture is shrunk to it; the work goes
    // with the number of pixels, and the places found come back in the picture's own coordinates.
    WholePicture(int internal, int width, int height)
    {
        const char *name = "human_face_detect_msr_s8_v1.espdl";
        m_model = nullptr;
        if (width > 0 && height > 0) {
            dl::Model *probe = new dl::Model(models, name, fbs::MODEL_LOCATION_IN_FLASH_RODATA, 0);
            auto &inputs = probe->get_inputs();
            std::string input = inputs.empty() ? std::string() : inputs.begin()->first;
            std::vector<int> shape = inputs.empty() ? std::vector<int>() : inputs.begin()->second->get_shape();
            delete probe;
            if (shape.size() == 4 && (shape[1] != height || shape[2] != width)) {
                shape[1] = height;
                shape[2] = width;
                m_model = new dl::Model(models, name, fbs::MODEL_LOCATION_IN_FLASH_RODATA, internal, dl::MEMORY_MANAGER_GREEDY, nullptr, true, {{input, shape}});
            }
        }
        if (!m_model)
            m_model = new dl::Model(models, name, fbs::MODEL_LOCATION_IN_FLASH_RODATA, internal);
        m_model->minimize();
        m_image_preprocessor = new dl::image::ImagePreprocessor(m_model, {0, 0, 0}, {1, 1, 1}, true);
        m_postprocessor = new dl::detect::MSRPostprocessor(
            m_model, m_image_preprocessor, 0.5, 0.5, 10, {{8, 8, 9, 9, {{16, 16}, {32, 32}}}, {16, 16, 9, 9, {{64, 64}, {128, 128}}}});
    }
};

// Second network: each place again at 48x48, which says whether it is a face and where exactly (as human_face_detect::MNP).
class EachPlace {
    dl::Model *m_model;
    dl::image::ImagePreprocessor *m_image_preprocessor;
    dl::detect::MNPPostprocessor *m_postprocessor;

public:
    EachPlace(int internal)
    {
        m_model = new dl::Model(models, "human_face_detect_mnp_s8_v1.espdl", fbs::MODEL_LOCATION_IN_FLASH_RODATA, internal);
        m_model->minimize();
        m_image_preprocessor = new dl::image::ImagePreprocessor(m_model, {0, 0, 0}, {1, 1, 1}, true);
        m_postprocessor = new dl::detect::MNPPostprocessor(m_model, m_image_preprocessor, 0.5, 0.5, 10, {{1, 1, 0, 0, {{48, 48}}}});
    }
    std::list<dl::detect::result_t> &run(const dl::image::img_t &img, std::list<dl::detect::result_t> &candidates)
    {
        m_postprocessor->clear_result();
        for (auto &candidate : candidates) {
            int center_x = (candidate.box[0] + candidate.box[2]) >> 1;
            int center_y = (candidate.box[1] + candidate.box[3]) >> 1;
            int side = DL_MAX(candidate.box[2] - candidate.box[0], candidate.box[3] - candidate.box[1]);
            candidate.box[0] = center_x - (side >> 1);
            candidate.box[1] = center_y - (side >> 1);
            candidate.box[2] = candidate.box[0] + side;
            candidate.box[3] = candidate.box[1] + side;
            candidate.limit_box(img.width, img.height);
            m_image_preprocessor->preprocess(img, candidate.box);
            m_model->run();
            m_postprocessor->postprocess();
        }
        m_postprocessor->nms();
        return m_postprocessor->get_result(img.width, img.height);
    }
};

static WholePicture *first;
static EachPlace *second;
// The other detector of the same package (14 Nov 2026): ESPDet-Pico, one network on a 224x224 picture. Espressif gives
// it 137 ms a picture against 40 for the pair above, and a better score (0.50 against 0.37): it is asked only when the
// pair finds nobody (live-device.js). The owner standing in front of the robot, his face well in the picture and seen
// from below, was not found once by the pair in twenty seconds of looking around.
static human_face_detect::ESPDet *deep;
static uint8_t *picture;
static int pictureWidth, pictureHeight;
// How to search (mode). 0: both networks. 1, quick: only the first network, and of its places the one nearest to where
// the face was (nearX, nearY); for a face that is being followed (not used: live-device.js SELF_QUICK). 2, deep: the
// other detector (ESPDet above), slow and more able.
static int quick, nearX, nearY;
static volatile int state; // 0 idle, 1 searching, 2 answer ready
static int16_t answer[6];  // found, x, y, size, score (0…1000), milliseconds
static SemaphoreHandle_t wake;
// For the log: internal RAM free before the networks were made and after, what they were given, and the time of the
// first network and of the whole search, last time (ms).
static int freeBefore, freeAfter, given, firstMs, places;
// The size the first network works at: asked (face-finder.js neuralSize) and made. 0: the network's own.
static volatile int wantWidth, wantHeight;
static int madeWidth = -1, madeHeight = -1;

static void make(void)
{
    freeBefore = (int)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    int spare = freeBefore - INTERNAL_KEEP;
    given = spare < 0 ? 0 : spare > INTERNAL_MOST ? INTERNAL_MOST : spare;
    // The second network is small (48x48): a quarter for it, the rest for the first.
    heap_caps_malloc_extmem_enable(32);
    if (!second)
        second = new EachPlace(given / 4);
    madeWidth = wantWidth;
    madeHeight = wantHeight;
    first = new WholePicture(given - given / 4, madeWidth, madeHeight);
    heap_caps_malloc_extmem_enable(CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL);
    freeAfter = (int)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
}

static void worker(void *)
{
    for (;;) {
        xSemaphoreTake(wake, portMAX_DELAY);
        int64_t from = esp_timer_get_time();
        answer[0] = answer[1] = answer[2] = answer[3] = answer[4] = 0;
        if (!first || madeWidth != wantWidth || madeHeight != wantHeight) {
            delete first;
            first = nullptr;
            make();
        }
        dl::image::img_t image = {picture, (uint16_t)pictureWidth, (uint16_t)pictureHeight, dl::image::DL_IMAGE_PIX_TYPE_RGB565LE};
        const dl::detect::result_t *best = nullptr;
        if (quick == 2) {
            if (!deep) {
                // Like the pair: nothing of it in the internal RAM.
                heap_caps_malloc_extmem_enable(32);
                deep = new human_face_detect::ESPDet("espdet_pico_224_224_face.espdl", 0.5f, 0.7f);
                heap_caps_malloc_extmem_enable(CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL);
            }
            auto &faces = deep->run(image);
            firstMs = (int)((esp_timer_get_time() - from) / 1000);
            places = (int)faces.size();
            for (const auto &face : faces)
                if (face.box.size() >= 4 && (!best || face.score > best->score))
                    best = &face;
            if (best) {
                int width = best->box[2] - best->box[0], height = best->box[3] - best->box[1];
                answer[0] = 1;
                answer[1] = (int16_t)((best->box[0] + best->box[2]) / 2);
                answer[2] = (int16_t)((best->box[1] + best->box[3]) / 2);
                answer[3] = (int16_t)(width > height ? width : height);
                answer[4] = (int16_t)(best->score * 1000.0f + 0.5f);
            }
            answer[5] = (int16_t)((esp_timer_get_time() - from) / 1000);
            state = 2;
            continue;
        }
        auto &candidates = first->run(image);
        firstMs = (int)((esp_timer_get_time() - from) / 1000);
        places = (int)candidates.size();
        if (quick) {
            long nearest = 0;
            for (const auto &place : candidates) {
                if (place.box.size() < 4)
                    continue;
                long dx = (place.box[0] + place.box[2]) / 2 - nearX, dy = (place.box[1] + place.box[3]) / 2 - nearY, d = dx * dx + dy * dy;
                long side = place.box[2] - place.box[0] > place.box[3] - place.box[1] ? place.box[2] - place.box[0] : place.box[3] - place.box[1];
                // The same face: its centre has not gone farther than its own size.
                if (d <= side * side && (!best || d < nearest)) {
                    best = &place;
                    nearest = d;
                }
            }
        } else {
            auto &faces = second->run(image, candidates);
            for (const auto &face : faces)
                if (face.box.size() >= 4 && (!best || face.score > best->score))
                    best = &face;
        }
        if (best) {
            int width = best->box[2] - best->box[0], height = best->box[3] - best->box[1];
            answer[0] = 1;
            answer[1] = (int16_t)((best->box[0] + best->box[2]) / 2);
            answer[2] = (int16_t)((best->box[1] + best->box[3]) / 2);
            answer[3] = (int16_t)(width > height ? width : height);
            answer[4] = (int16_t)(best->score * 1000.0f + 0.5f);
        }
        answer[5] = (int16_t)((esp_timer_get_time() - from) / 1000);
        state = 2;
    }
}

// 1: the search has started on a copy of the picture; 0: one is still running; -1: it cannot run.
static int start(const uint8_t *rgb565le, int width, int height, int quickly, int x, int y)
{
    if (state == 1)
        return 0;
    if (width < 24 || height < 24 || width * height > MAX_PIXELS)
        return -1;
    if (!wake) {
        // What could be made stays for the next try (14 Nov 2026: each failed try used to leave 38 KB and a semaphore behind).
        if (!picture)
            picture = (uint8_t *)heap_caps_malloc(MAX_PIXELS * 2, MALLOC_CAP_SPIRAM);
        static SemaphoreHandle_t made;
        if (!made)
            made = xSemaphoreCreateBinary();
        if (!picture || !made)
            return -1;
        // The task waits on `wake` from its first line: set before the task exists.
        wake = made;
        if (xTaskCreatePinnedToCoreWithCaps(worker, "robottino-face", TASK_STACK, nullptr, TASK_PRIORITY, nullptr, TASK_CORE, MALLOC_CAP_SPIRAM) != pdPASS) {
            wake = nullptr;
            return -1;
        }
    }
    memcpy(picture, rgb565le, (size_t)width * height * 2);
    pictureWidth = width;
    pictureHeight = height;
    quick = quickly;
    nearX = x;
    nearY = y;
    state = 1;
    xSemaphoreGive(wake);
    return 1;
}

// 1: the answer is in out (six numbers, see answer); 0: still searching; -1: nothing was asked.
static int poll(int16_t *out)
{
    if (state != 2)
        return state == 1 ? 0 : -1;
    memcpy(out, answer, sizeof(answer));
    state = 0;
    return 1;
}

// The size the first network works at from the next search on (0, 0: its own 160x120). Multiples of 16.
static int size(int width, int height)
{
    if (width < 0 || height < 0 || width > 160 || height > 120 || width % 16 || height % 4)
        return 0;
    wantWidth = width;
    wantHeight = height;
    return 1;
}

// What the log shows about the detector (face-finder.js neuralInfo): the internal RAM free before and after the
// networks were made, now, and the least it has ever been. When it is near 0 a microphone or a speaker cannot be opened
// (13 Nov 2026, a conversation ended in error). (The pool of CONFIG_SPIRAM_MALLOC_RESERVE_INTERNAL is not a fund apart:
// in ESP-IDF 6.1 ordinary small requests use it too, after the rest of the internal RAM.)
static int info(char *out, int size)
{
    return snprintf(out, size, "at %dx%d internal %d>%d now %d low %d KB first %d ms places %d", madeWidth, madeHeight, freeBefore / 1024, freeAfter / 1024,
                    (int)heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024, (int)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL) / 1024, firstMs, places);
}

__attribute__((constructor)) static void offer(void)
{
    robottino_face_backend(start, poll, info, size);
    robottino_video_offer();
}

// Face finding on the robot itself (13 Nov 2026, owner: the head follows a face «tramite il robottino, non iPhone…
// il più veloce possibile»). Pure C, no allocation, no recursion: it runs on the robot's main task (16 KB of native
// stack) and on the Mac for the tests. The detector is pico (picornt.c, MIT, Nenad Markuš) with its «facefinder»
// cascade; only its run_cascade() is used, the search and the grouping are here.
#pragma once
#include <stdint.h>

#define ROBOTTINO_FACE_MAX_PIXELS (160 * 120)

typedef struct {
	int16_t x, y, size; // centre and side of the face, in pixels of the picture
	float score;        // summed confidence of the windows that agree (0 = none)
	int16_t windows;    // how many windows agreed
	int32_t tested;     // windows tried (for the timing on the log)
} RobottinoFace;

// grey: width*height bytes. hint: where the face was in the last picture (NULL: look everywhere).
// Returns 1 when a face is found. minSize/maxSize in pixels (0: the defaults for this picture).
int robottino_face_find(const void *cascade, const uint8_t *grey, int width, int height, const RobottinoFace *hint,
                        int minSize, int maxSize, RobottinoFace *out);
// RGB565 little endian (the camera's format) to grey, one byte a pixel.
void robottino_face_grey(const uint8_t *rgb565le, uint8_t *grey, int pixels);

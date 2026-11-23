#include "face-finder-core.h"

int run_cascade(void *cascade, float *o, int r, int c, int s, void *vppixels, int nrows, int ncols, int ldim);

void robottino_face_grey(const uint8_t *rgb, uint8_t *grey, int pixels) {
	for (int i = 0; i < pixels; i++) {
		uint32_t v = rgb[2 * i] | (rgb[2 * i + 1] << 8);
		uint32_t r = v >> 11, g = (v >> 5) & 63, b = v & 31;
		// 0.30 R + 0.59 G + 0.11 B, with the 5 and 6 bit channels brought to 8 bits inside the weights.
		grey[i] = (uint8_t)((r * 613 + g * 601 + b * 232) >> 8);
	}
}

// Windows that agree are grouped as they come: no list of all of them, no recursion.
#define GROUPS 12
typedef struct { float x, y, size, score; int n; } Group;

static void add(Group *groups, int *count, float x, float y, float size, float score) {
	for (int i = 0; i < *count; i++) {
		Group *g = &groups[i];
		float gx = g->x / g->n, gy = g->y / g->n, gs = g->size / g->n, reach = 0.35f * (gs > size ? gs : size);
		float dx = gx - x, dy = gy - y;
		if (dx < 0) dx = -dx;
		if (dy < 0) dy = -dy;
		if (dx <= reach && dy <= reach && size <= 1.6f * gs && gs <= 1.6f * size) {
			g->x += x; g->y += y; g->size += size; g->score += score; g->n++;
			return;
		}
	}
	if (*count < GROUPS) {
		Group *g = &groups[(*count)++];
		g->x = x; g->y = y; g->size = size; g->score = score; g->n = 1;
		return;
	}
	// Full: the weakest single window gives way to a stronger one.
	int weakest = 0;
	for (int i = 1; i < GROUPS; i++) if (groups[i].score < groups[weakest].score) weakest = i;
	if (groups[weakest].score < score) { Group *g = &groups[weakest]; g->x = x; g->y = y; g->size = size; g->score = score; g->n = 1; }
}

// One search: sizes from low to high (each `grow` times the one before), centres `stride` of the size apart, inside
// the given rectangle. Returns the windows tried.
static int scan(const void *cascade, const uint8_t *grey, int width, int height, float low, float high, float grow, float stride,
                float left, float top, float right, float bottom, Group *groups, int *count) {
	int tested = 0;
	for (float s = low; s <= high; s *= grow) {
		float step = stride * s, half = s / 2 + 1;
		if (step < 1) step = 1;
		float r0 = top > half ? top : half, r1 = bottom < height - half ? bottom : height - half;
		float c0 = left > half ? left : half, c1 = right < width - half ? right : width - half;
		for (float r = r0; r <= r1; r += step)
			for (float c = c0; c <= c1; c += step) {
				float q;
				tested++;
				if (run_cascade((void *)cascade, &q, (int)r, (int)c, (int)s, (void *)grey, height, width, width) == 1) add(groups, count, c, r, s, q);
			}
	}
	return tested;
}

static int strongest(const Group *groups, int count) {
	int best = -1;
	for (int i = 0; i < count; i++) if (best < 0 || groups[i].score > groups[best].score) best = i;
	return best;
}

// Around a place where a face is expected: every size near its own, centres a tenth of the size apart.
static int near(const void *cascade, const uint8_t *grey, int width, int height, float x, float y, float size, float low, float high,
                Group *groups, int *count) {
	float reach = 0.75f * size, from = 0.78f * size > low ? 0.78f * size : low, to = 1.3f * size < high ? 1.3f * size : high;
	return scan(cascade, grey, width, height, from, to, 1.12f, 0.1f, x - reach, y - reach, x + reach, y + reach, groups, count);
}

int robottino_face_find(const void *cascade, const uint8_t *grey, int width, int height, const RobottinoFace *hint,
                        int minSize, int maxSize, RobottinoFace *out) {
	Group groups[GROUPS];
	int count = 0, tested = 0, shorter = width < height ? width : height;
	float low = minSize > 0 ? minSize : 20, high = maxSize > 0 ? maxSize : shorter - 2;
	out->x = out->y = out->size = out->windows = 0; out->score = 0; out->tested = 0;
	if (!cascade || !grey || width < 24 || height < 24 || width * height > ROBOTTINO_FACE_MAX_PIXELS) return 0;
	if (high > shorter - 2) high = shorter - 2;
	if (hint && hint->size > 0) {
		// The face moves little between two pictures: only around where it was, at about its size.
		tested = near(cascade, grey, width, height, hint->x, hint->y, hint->size, low, high, groups, &count);
	} else {
		// Everywhere, in two steps (13 Nov 2026: the fine search of the whole 160×120 picture took 80 ms on the robot):
		// a coarse one, under half of the windows (sizes 1.15 apart, centres 0.15 of the size: on 22 test pictures it finds
		// the same faces as the fine one), only to see where a face may be; then the fine one around the best
		// places, which gives the place and the confidence as the search around a known face does.
		Group coarse[GROUPS];
		int places = 0;
		tested = scan(cascade, grey, width, height, low, high, 1.15f, 0.15f, 0, 0, width, height, coarse, &places);
		for (int tries = 0; tries < 2 && places > 0; tries++) {
			int best = strongest(coarse, places);
			Group *g = &coarse[best];
			tested += near(cascade, grey, width, height, g->x / g->n, g->y / g->n, g->size / g->n, low, high, groups, &count);
			coarse[best] = coarse[--places];
		}
	}
	out->tested = tested;
	int best = strongest(groups, count);
	if (best < 0) return 0;
	Group *g = &groups[best];
	out->x = (int16_t)(g->x / g->n + 0.5f); out->y = (int16_t)(g->y / g->n + 0.5f); out->size = (int16_t)(g->size / g->n + 0.5f);
	out->score = g->score; out->windows = (int16_t)g->n;
	return 1;
}

// Which side a sound comes from (14 Nov 2026, owner: «girarsi verso la voce quando non ti vede»).
// A sound from one side reaches the nearer microphone a fraction of a millisecond before the other. The two channels
// are compared shifted against each other by −6…+6 samples, and the shift at which they are most alike is the
// answer, refined between two whole samples with a parabola through the best value and its two neighbours.
// Before comparing, each channel is replaced by the difference between a sample and the one two before: this takes
// away the steady level and the low hum (the same on both channels whatever the side) and also the very highest
// pitches, which change too much between two samples for a delay of half a sample to be read; what is left, around
// 4 kHz at 16 kHz, are the sharp parts of a voice or a clap, the ones that tell the side.
// No memory is taken and nothing is kept between calls.
#include "sound-side-core.h"
#include <math.h>
#include <stddef.h>

#define LAGS (2 * ROBOTTINO_SOUND_MAX_LAG + 1)

int robottino_sound_side(const int16_t *s, int frames, RobottinoSoundSide *out) {
	if (s == NULL || out == NULL || frames < 4 * ROBOTTINO_SOUND_MAX_LAG + 16) return 0;
	if (frames > ROBOTTINO_SOUND_MAX_FRAMES) frames = ROBOTTINO_SOUND_MAX_FRAMES;

	int64_t sumA = 0, sumB = 0;
	for (int i = 0; i < frames; i++) { sumA += s[2 * i]; sumB += s[2 * i + 1]; }
	int32_t meanA = (int32_t)(sumA / frames), meanB = (int32_t)(sumB / frames);
	int64_t absA = 0, absB = 0;
	for (int i = 0; i < frames; i++) {
		int32_t a = s[2 * i] - meanA, b = s[2 * i + 1] - meanB;
		absA += a < 0 ? -a : a;
		absB += b < 0 ? -b : b;
	}
	out->level = (int32_t)((absA > absB ? absA : absB) / frames);
	out->lag16 = 0;
	out->quality = 0;

	// alike[k]: first channel at i against second channel at i + (k − MAX_LAG).
	int64_t alike[LAGS] = {0}, energyA = 0, energyB = 0;
	for (int i = ROBOTTINO_SOUND_MAX_LAG + 2; i < frames - ROBOTTINO_SOUND_MAX_LAG; i++) {
		int32_t a = (int32_t)s[2 * i] - s[2 * (i - 2)];
		int32_t b = (int32_t)s[2 * i + 1] - s[2 * (i - 2) + 1];
		energyA += (int64_t)a * a;
		energyB += (int64_t)b * b;
		const int16_t *second = s + 2 * (i - ROBOTTINO_SOUND_MAX_LAG) + 1;
		for (int k = 0; k < LAGS; k++, second += 2)
			alike[k] += (int64_t)a * ((int32_t)second[0] - second[-4]);
	}
	if (energyA <= 0 || energyB <= 0) return 1; // silence: loudness 0, no side

	int best = 0;
	for (int k = 1; k < LAGS; k++) if (alike[k] > alike[best]) best = k;
	if (alike[best] <= 0) return 1;
	double lag = best - ROBOTTINO_SOUND_MAX_LAG, top = (double)alike[best];
	if (best > 0 && best < LAGS - 1) {
		double before = (double)alike[best - 1], here = (double)alike[best], after = (double)alike[best + 1];
		double bend = before - 2 * here + after;
		if (bend < 0) {
			double shift = 0.5 * (before - after) / bend;
			lag += shift;
			top = here - 0.25 * (before - after) * shift; // the top of the parabola: a delay between two samples is not a worse match
		}
	}
	double quality = top / sqrt((double)energyA * (double)energyB);
	if (quality > 1) quality = 1;
	out->lag16 = (int32_t)lround(lag * 16);
	out->quality = (int32_t)lround(quality * 255);
	return 1;
}

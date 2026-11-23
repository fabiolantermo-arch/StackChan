// Which side a sound comes from, from the robot's two microphones (14 Nov 2026). Plain C: also built and tried on the
// Mac (firmware/host/sound-side.test.mjs).
#ifndef ROBOTTINO_SOUND_SIDE_CORE_H
#define ROBOTTINO_SOUND_SIDE_CORE_H
#include <stdint.h>

#define ROBOTTINO_SOUND_MAX_LAG 6      // samples each way: at 16 kHz, microphones up to 12 cm apart
#define ROBOTTINO_SOUND_MAX_FRAMES 4096 // a quarter of a second at 16 kHz: what is beyond is not looked at

typedef struct {
	int32_t level;   // how loud: mean distance from its own average, of the louder channel (0…32767)
	int32_t lag16;   // by how much the second channel hears the sound after the first, in sixteenths of a sample
	                 // (negative: the second channel hears it first); ±16*ROBOTTINO_SOUND_MAX_LAG at most
	int32_t quality; // 0…255: how alike the two channels are once shifted by that much (255: the same sound)
} RobottinoSoundSide;

// samples: 16-bit, the two channels in turn (first, second, first, …); frames: how many pairs.
// Returns 1 and fills out, or 0 when there is too little to say anything.
int robottino_sound_side(const int16_t *samples, int frames, RobottinoSoundSide *out);

#endif

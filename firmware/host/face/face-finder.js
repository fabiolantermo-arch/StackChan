// Finds a face in a camera picture, on the robot itself (firmware/host/face, 13 Nov 2026). For mods:
// Modules.importNow('robottino-face-finder'). No picture is kept and nobody is recognized: only where a face is.
//
// find(frame, width, height, hintX, hintY, hintSize, minSize, maxSize)
//   frame: the camera's RGB565 little-endian buffer, width*height*2 bytes, at most 160×120.
//   hint*: where the face was in the last picture (size 0: look everywhere).
//   Returns 0 when there is no face, otherwise one number: x + y*256 + size*65536 + round(score*10)*16777216
//   (centre and side in pixels; score: summed confidence of the windows that agree, about 5 and up for a face).
export function find(frame, width, height, hintX = 0, hintY = 0, hintSize = 0, minSize = 0, maxSize = 0) {
  return native('xs_robottino_face_find').call(null, frame, width, height, hintX, hintY, hintSize, minSize, maxSize)
}
/** Windows tried by the last find(): for the timing on the log. */
export function tested() {
  return native('xs_robottino_face_tested').call(null)
}
export const unpack = (value) =>
  value ? { x: value & 255, y: (value >>> 8) & 255, size: (value >>> 16) & 255, score: Math.floor(value / 16777216) / 10 } : undefined

// The neural detector (Espressif's esp-dl, face-dl.cpp): it finds real faces where the cascade above does not. It
// works in its own task, so nothing waits for it: startNeural() hands a copy of the picture over, pollNeural() says
// later what it found.
/** true when this host was built with the neural detector. */
export function neural() {
  return native('xs_robottino_face_neural').call(null)
}
/**
 * 1: the search started; 0: the last one is still running; -1: it cannot run.
 * quick: only the detector's first network, and the place it gives nearest to nearX, nearY (a face being followed);
 * otherwise both networks, which say for sure that it is a face.
 */
export function startNeural(frame, width, height, quick = false, nearX = 0, nearY = 0) {
  // quick may also be 2: the other detector of the host (slower, finds more; 14 Nov 2026).
  return native('xs_robottino_face_neural_start').call(null, frame, width, height, quick === 2 ? 2 : quick ? 1 : 0, nearX, nearY)
}
/** -1: still searching (or nothing asked); 0: no face; otherwise a number for unpackNeural(). */
export function pollNeural() {
  return native('xs_robottino_face_neural_poll').call(null)
}
/** How long the last finished search took, in ms. */
export function neuralMs() {
  return native('xs_robottino_face_neural_ms').call(null)
}
/** Centre and side in pixels, score 0…1. */
export const unpackNeural = (value) =>
  value > 0 ? { x: value & 255, y: (value >>> 8) & 255, size: (value >>> 16) & 255, score: Math.floor(value / 16777216) / 1000 } : undefined
/** For the log: the detector's memory and the time of its first network. */
export function neuralInfo() {
  return native('xs_robottino_face_neural_info').call(null)
}
/** The size the detector works at from the next search on: smaller is faster and sees near faces only (0, 0: its own 160×120). */
export function neuralSize(width, height) {
  return native('xs_robottino_face_neural_size').call(null, width, height)
}
/** TEMPORARY diagnostics: the Wi-Fi as the chip sees it («rssi -70 ch 6 drops 3 last 200 at -82»; see face-finder.c). */
export function wifiInfo() {
  return native('xs_robottino_wifi_info').call(null)
}
/**
 * Which side a sound comes from (14 Nov 2026). samples: what embedded:io/audio/in gives with channels 2 (16-bit, the
 * two microphones in turn). Returns 0 when there is too little to say, otherwise a number for unpackSound().
 */
export function soundSide(samples) {
  return native('xs_robottino_sound_side').call(null, samples)
}
/**
 * level: how loud (0…32767). lag: by how many samples the second channel hears the sound after the first
 * (negative: before), to a sixteenth of a sample. quality: 0…1, how alike the two channels are at that shift.
 */
export const unpackSound = (value) =>
  value > 0 ? { level: value & 65535, quality: ((value >>> 16) & 255) / 255, lag: (Math.floor(value / 16777216) - 128) / 16 } : undefined
/** The robot's two memories, in KB: size, free now, least ever free, largest free piece («inside … | outside …»). */
export function memoryInfo() {
  return native('xs_robottino_memory_info').call(null)
}
/**
 * The camera picture as a JPEG, for the Live video (14 Nov 2026). frame: the camera's RGB565 little-endian buffer.
 * Returns an ArrayBuffer of `head` empty bytes followed by the JPEG, or a negative number when it could not be made
 * (see face-finder.c). quality: 10…95.
 */
export function videoJpeg(frame, width, height, quality = 60, head = 0) {
  return native('xs_robottino_video_jpeg').call(null, frame, width, height, quality, head)
}
/** Gives back the JPEG encoder and its memory (when the video stops). */
export function videoEnd() {
  return native('xs_robottino_video_end').call(null)
}
/** How long the last JPEG took to make, in ms. */
export function videoMs() {
  return native('xs_robottino_video_ms').call(null)
}
/**
 * One JPEG picture of the start-up video made into screen pixels (14 Nov 2026). data: an ArrayBuffer or a resource;
 * the picture is `length` bytes at `offset`. Returns a host buffer over the pixels (width*height*2 bytes; the same
 * memory every time, written again by the next call), or a negative number when it could not be done.
 */
export function screenJpeg(data, offset, length, bigEndian = true) {
  return native('xs_robottino_screen_jpeg').call(null, data, offset, length, bigEndian)
}
/** «width height ms» of the last screenJpeg. */
export function screenInfo() {
  return native('xs_robottino_screen_info').call(null)
}
/** Gives back the memory of screenJpeg. */
export function screenEnd() {
  return native('xs_robottino_screen_end').call(null)
}


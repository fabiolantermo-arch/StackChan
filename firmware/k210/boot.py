# Robottino, the K210 camera (M5Stack UnitV): finds the largest face in every picture and tells the robot where it
# is, over the Grove cable. MaixPy (MicroPython); as boot.py it starts by itself when the camera is powered.
#
# Tried on 23 Nov 2026 (faces). Written before the camera arrived (14 Nov 2026). The things to check with the camera in hand are
# marked «CHECK». The robot's side is firmware/stackchan-mod/k210.js: the 12 bytes below are the same there and in
# scripts/virtual-k210.mjs; change the three together.
#
#   0 'R'  1 'K'  2 version (1)  3 picture number (0…255)  4 faces in the picture
#   5, 6 middle of the largest face, 0…255 from the left and from the top    7, 8 its width and height, 0…255
#   9 how sure, 0…100    10 ms spent on this picture (255 = that or more)    11 CRC-8 (polynomial 7) of bytes 2…10
#
# Since 23 Nov 2026 (owner: «nella live dell'app si deve vedere la nuova camera») a small picture leaves the camera
# too, for the app's Live: 160×120 JPEG, cut in pieces of at most 96 bytes, each in its own frame:
#   0 'R'  1 'J'  2 version (1)  3 picture number (0…255)  4 piece (0…)  5 pieces in all (1…100)  6 bytes in this
#   piece (1…40)  7… the bytes  last: CRC-8 of bytes 2 up to the last one before it
# The robot reads its line without a memory of its own (the chip keeps 128 bytes): so at most PIECES_PER_PICTURE pieces
# go after each look for faces, PIECE_GAP_MS apart. First tried with two pieces of 96 bytes 25 ms apart: the robot read
# 5 to 28 face frames in 5 s instead of 72 and no picture whole. Now one piece of 40 bytes a look: 60 bytes a look in
# all, a picture every 2 or 3 seconds. Faces first: their 12 bytes always go.
# Nothing is read from the robot.
import sensor, time
import KPU as kpu
from machine import UART
from fpioa_manager import fm

TX_PIN = 35         # CHECK: the Grove pin the frames leave on (34 or 35). The robot tries both of its wires by itself.
MODEL = 0x300000    # CHECK: the face model in the camera's flash (face_model_at_0x300000.kfpkg), or "/sd/face.kmodel"
ANCHORS = (1.889, 2.5245, 2.9465, 3.94056, 3.99987, 5.3658, 5.155437, 6.92275, 6.718375, 9.01025)
THRESHOLD = 0.5     # how sure before a face counts
WIDTH, HEIGHT = 320, 240
# Mounted lying on its side, lens forward, USB-C on the left (23 Nov 2026): the picture is upright as it comes, the
# owner's face found in 5 pictures of 5 (88-91%). With USB-C on the right it comes upside down, and FLIP and MIRROR
# both 1 turn it back but the colours go green (the sensor reads its colours in the wrong order) and no face was found.
FLIP, MIRROR = 0, 0 # 1 if the camera is mounted upside down / shows left and right exchanged (left and right: not yet seen)
# Held upright (long side up, cable below) the camera's picture lies on its side, and the face finder finds only
# upright faces (23 Nov 2026, the owner's face in hand: nothing; turned by 90°: found, 91% sure). ROTATE turns each
# picture by that many degrees before the faces are looked for (0, 90 or -90), at about 65 ms a picture.
ROTATE = 0
PAUSE_MS = 0        # CHECK: raise it if the robot's log shows frames lost (its line holds 128 bytes: 10 frames)
PICTURES = False              # the small pictures for the app: off for now (owner, 23 Nov 2026: «disabilitare la live con
                              # la K210 e soffermarci sull'inseguimento»); the faces alone keep the line free
SMALL_W, SMALL_H = 160, 120   # the picture for the app
QUALITY = 30                  # JPEG quality of that picture (about 1,5 KB)
PIECE = 40                    # bytes of picture in one frame (96 flooded the robot's line: 23 Nov 2026)
PIECES_PER_PICTURE = 1        # frames of picture after each look for faces
PIECE_GAP_MS = 0              # before each of them (with one a look, the look itself is the pause)


def crc8(data, start, end):
    crc = 0
    for i in range(start, end):
        crc ^= data[i]
        for _ in range(8):
            crc = ((crc << 1) ^ 7) & 255 if crc & 0x80 else (crc << 1) & 255
    return crc


def byte(value):
    value = int(value + 0.5)
    return 0 if value < 0 else 255 if value > 255 else value


def light(red, green, blue):
    # The camera's own small light (pin 8). It only says that the script runs; no error here may stop the camera.
    try:
        from modules import ws2812
        led = ws2812(8, 1)
        led.set_led(0, (red, green, blue))
        led.display()
    except Exception:
        pass


def main():
    fm.register(TX_PIN, fm.fpioa.UART1_TX, force=True)
    # CHECK: M5Stack's own examples open the line like this (8 bits, no parity, 1 stop bit).
    uart = UART(UART.UART1, 115200, 8, 0, 0, timeout=1000, read_buf_len=64)

    sensor.reset()
    sensor.set_pixformat(sensor.RGB565)
    sensor.set_framesize(sensor.QVGA)
    sensor.set_vflip(FLIP)
    sensor.set_hmirror(MIRROR)
    sensor.run(1)
    sensor.skip_frames(time=500)

    task = kpu.load(MODEL)
    kpu.init_yolo2(task, THRESHOLD, 0.3, 5, ANCHORS)
    light(8, 8, 8)

    piece = bytearray(8 + PIECE)
    piece[0] = 0x52
    piece[1] = 0x4A
    piece[2] = 1
    picture_number = 0
    jpeg = None      # the picture being sent, as bytes
    pieces = 0
    next_piece = 0

    frame = bytearray(12)
    frame[0] = 0x52
    frame[1] = 0x4B
    frame[2] = 1
    number = 0
    while True:
        began = time.ticks_ms()
        picture = sensor.snapshot()
        if ROTATE:
            picture = picture.rotation_corr(z_rotation=ROTATE)
            picture.pix_to_ai()  # the face finder reads its own copy of the picture: made again from the turned one
        found = kpu.run_yolo2(task, picture)
        best = None
        count = 0
        if found:
            count = len(found)
            for face in found:
                if best is None or face.w() * face.h() > best.w() * best.h():
                    best = face
        frame[3] = number & 255
        frame[4] = 255 if count > 255 else count
        if best is None:
            frame[5] = frame[6] = frame[7] = frame[8] = frame[9] = 0
        else:
            frame[5] = byte((best.x() + best.w() / 2) * 255 / WIDTH)
            frame[6] = byte((best.y() + best.h() / 2) * 255 / HEIGHT)
            frame[7] = byte(best.w() * 255 / WIDTH)
            frame[8] = byte(best.h() * 255 / HEIGHT)
            frame[9] = min(100, byte(best.value() * 100))
        frame[10] = byte(time.ticks_diff(time.ticks_ms(), began))
        frame[11] = crc8(frame, 2, 11)
        uart.write(frame)
        # The small picture: a new one when the last has gone, then a few pieces after each look for faces.
        if PICTURES and jpeg is None:
            try:
                small = picture.resize(SMALL_W, SMALL_H)
                small.compress(quality=QUALITY)
                jpeg = small.to_bytes()
                del small
                pieces = (len(jpeg) + PIECE - 1) // PIECE
                if pieces < 1 or pieces > 100:
                    jpeg = None
                next_piece = 0
                picture_number = (picture_number + 1) & 255
            except Exception as error:
                jpeg = None
                print("robottino k210 picture:", error)
        if jpeg is not None:
            for _ in range(PIECES_PER_PICTURE):
                start = next_piece * PIECE
                part = jpeg[start:start + PIECE]
                size = len(part)
                piece[3] = picture_number
                piece[4] = next_piece
                piece[5] = pieces
                piece[6] = size
                piece[7:7 + size] = part
                piece[7 + size] = crc8(piece, 2, 7 + size)
                if PIECE_GAP_MS:
                    time.sleep_ms(PIECE_GAP_MS)
                uart.write(piece[0:8 + size])
                next_piece += 1
                if next_piece >= pieces:
                    jpeg = None
                    break
        number += 1
        if number == 20:
            light(0, 0, 0)  # the light goes off after the first pictures: it would shine in the owner's eyes
        if PAUSE_MS:
            time.sleep_ms(PAUSE_MS)


try:
    main()
except Exception as error:
    # Something is missing (most likely the face model): a red light, and the reason on the USB serial console.
    print("robottino k210:", error)
    light(40, 0, 0)

# Runs the camera's own script (boot.py) on the Mac, whole, with pretend MaixPy modules in place of the camera:
# a sensor that hands out the pictures it is told to, a face finder that «finds» the faces it is told to, a serial
# line that keeps what is written on it, the small light, and the camera's clock.
# It proves that the script runs from the first line to the loop and what bytes it sends; it does not prove that the
# real MaixPy has these very calls (they are the ones of M5Stack's and Sipeed's examples): that needs the camera.
#
#   python3 -I firmware/k210/pretend-maixpy.py firmware/k210/boot.py '{"pictures":[[],[[48,132,64,72,0.9]]]}'
#
# pictures: for every picture the faces in it, each [x, y, width, height, how sure] in pixels of the 320×240 picture.
# ms: what one picture costs on the pretend clock (50). noModel: the face model is missing. noLight: no light module.
# jpeg: bytes of each small picture for the app (250). noResize: a MaixPy whose pictures cannot be made smaller.
# picturesOn: the small pictures switched on (they are off in the script).
# It prints one line of JSON: hex (the bytes sent), calls (what the script asked of the camera), lights, printed.
import sys, json, types, io, contextlib

script, scenario = sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
pictures = scenario.get("pictures", [])
calls, lights, sent, clock, taken = [], [], bytearray(), [0], [0]


class Finished(BaseException):
    # The pictures are over. Not an Exception: the script's own «except Exception» must not take it for a fault.
    pass


class Face:
    def __init__(self, x, y, w, h, value):
        self._x, self._y, self._w, self._h, self._value = x, y, w, h, value

    def x(self): return self._x
    def y(self): return self._y
    def w(self): return self._w
    def h(self): return self._h
    def value(self): return self._value


def module(name, **members):
    made = types.ModuleType(name)
    made.__dict__.update(members)
    sys.modules[name] = made
    return made


def note(name):
    def call(*args, **named):
        calls.append([name, list(args), named])
    return call


class Picture:
    # One picture: its number, for the face finder; made smaller and turned into JPEG for the app (23 Nov 2026). The
    # JPEG is scenario["jpeg"] bytes (250 by default): FF D8, the picture's number again and again, FF D9.
    def __init__(self, number, width=320, height=240):
        self.number, self.width, self.height, self.jpeg = number, width, height, None

    def resize(self, width, height):
        calls.append(["image.resize", [width, height], {}])
        if scenario.get("noResize"):
            raise AttributeError("'Image' object has no attribute 'resize'")
        return Picture(self.number, width, height)

    def compress(self, quality=50):
        calls.append(["image.compress", [], {"quality": quality}])
        size = max(4, scenario.get("jpeg", 250))
        self.jpeg = bytes([0xFF, 0xD8]) + bytes([self.number & 255]) * (size - 4) + bytes([0xFF, 0xD9])
        return self

    def to_bytes(self):
        return self.jpeg

    def rotation_corr(self, z_rotation=0):
        calls.append(["image.rotation_corr", [], {"z_rotation": z_rotation}])
        clock[0] += 65
        return Picture(self.number, self.width, self.height)

    def pix_to_ai(self):
        calls.append(["image.pix_to_ai", [], {}])


def snapshot():
    if taken[0] >= len(pictures):
        raise Finished()
    clock[0] += scenario.get("ms", 50)
    taken[0] += 1
    return Picture(taken[0] - 1)


def load(model):
    calls.append(["kpu.load", [model], {}])
    if scenario.get("noModel"):
        raise OSError("no model at this address")
    return "task"


def run_yolo2(task, picture):
    found = [Face(*face) for face in pictures[picture.number]]
    return found or None


class UART:
    UART1 = "UART1"

    def __init__(self, *args, **named):
        calls.append(["UART", list(args), named])

    def write(self, data):
        sent.extend(bytes(data))
        return len(data)


class Light:
    def __init__(self, pin, count):
        self.pin, self.colour = pin, None

    def set_led(self, index, colour):
        self.colour = list(colour)

    def display(self):
        lights.append([self.pin] + self.colour)


def sleep_ms(ms):
    clock[0] += ms


module("sensor", RGB565="RGB565", QVGA="QVGA", reset=note("sensor.reset"), set_pixformat=note("sensor.set_pixformat"),
       set_framesize=note("sensor.set_framesize"), set_vflip=note("sensor.set_vflip"),
       set_hmirror=note("sensor.set_hmirror"), run=note("sensor.run"), skip_frames=note("sensor.skip_frames"),
       snapshot=snapshot)
module("KPU", load=load, init_yolo2=note("kpu.init_yolo2"), run_yolo2=run_yolo2)
module("machine", UART=UART)
module("fpioa_manager", fm=types.SimpleNamespace(fpioa=types.SimpleNamespace(UART1_TX="UART1_TX", UART1_RX="UART1_RX"),
                                                 register=note("fm.register")))
if not scenario.get("noLight"):
    module("modules", ws2812=Light)
module("time", ticks_ms=lambda: clock[0], ticks_diff=lambda later, sooner: later - sooner, sleep_ms=sleep_ms)

printed = io.StringIO()
with open(script, encoding="utf-8") as file:
    source = file.read()
if scenario.get("rotate"):
    source = source.replace("ROTATE = 0", "ROTATE = %d" % scenario["rotate"], 1)
if scenario.get("picturesOn"):
    # The small pictures for the app are off in the script for now (23 Nov 2026): the tests of their pieces turn them on.
    source = source.replace("PICTURES = False", "PICTURES = True", 1)
with contextlib.redirect_stdout(printed):
    try:
        exec(compile(source, script, "exec"), {"__name__": "__main__"})
    except Finished:
        pass
print(json.dumps({"hex": sent.hex(), "calls": calls, "lights": lights, "printed": printed.getvalue(), "taken": taken[0]}))

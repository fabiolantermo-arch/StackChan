# Puts firmware/k210/boot.py on the K210 camera (M5Stack UnitV with MaixPy) through its USB console, from the Mac.
# Use (ESP-IDF's Python has pyserial):
#   work/espressif-tools/python_env/idf6.1_py3.14_env/bin/python firmware/k210/install.py /dev/cu.usbserial-… [backup folder]
# What it does, in this order: stops whatever runs (Ctrl-C), saves the boot.py that is on the camera in the backup
# folder (only if no copy is there yet), writes ours, reads it back and compares, restarts the camera.
# Nothing else on the camera is touched: MaixPy and the face model at 0x300000 stay as they are (23 Nov 2026: the
# UnitV as it comes from the box, MaixPy v0.4.0 of 2019, already has KPU, the sensor and the face model).
import sys, time, os, hashlib, binascii, serial
port = sys.argv[1]
backup = sys.argv[2] if len(sys.argv) > 2 else 'work/k210-factory'
here = os.path.dirname(os.path.abspath(__file__))
ours = open(os.path.join(here, 'boot.py'), 'rb').read()
s = serial.Serial(); s.port = port; s.baudrate = 115200; s.timeout = 0.3; s.dtr = False; s.rts = False; s.open()
def read(seconds, until=None):
    end = time.time() + seconds; out = b''
    while time.time() < end:
        out += s.read(4096)
        if until and until in out: break
    return out
def raw(code, wait=8):
    s.write(b'\x01'); read(0.5)
    for i in range(0, len(code), 128):
        s.write(code[i:i+128].encode()); time.sleep(0.02)
    s.write(b'\x04')
    out = read(wait, b'\x04>')
    s.write(b'\x02'); read(0.3)
    text = out.decode('utf-8', 'replace')
    return text.split('OK', 1)[1] if 'OK' in text else text
# The camera prints its start for about 5 s and takes no Ctrl-C before it has finished (23 Nov 2026).
read(6.0); s.write(b'\x03'); time.sleep(0.2); s.write(b'\x03'); read(1.5)
def fetch(path):
    out = raw("import ubinascii\nf=open(%r,'rb')\nwhile True:\n b=f.read(96)\n if not b: break\n print(ubinascii.hexlify(b).decode())\nf.close()\nprint('END')\n" % path, 20)
    data = b''
    for line in out.splitlines():
        line = line.strip()
        if line == 'END': return data
        try: data += binascii.unhexlify(line)
        except Exception: pass
    raise SystemExit('could not read ' + path + ' from the camera: ' + out[-200:])
before = fetch('/flash/boot.py')
os.makedirs(backup, exist_ok=True)
saved = os.path.join(backup, 'boot.py')
if before == ours: print('the camera already has our boot.py')
elif not os.path.exists(saved):
    open(saved, 'wb').write(before); print('saved the camera\'s own boot.py (%d bytes) in %s' % (len(before), saved))
else: print('a backup is already in %s: kept as it is' % saved)
if before != ours:
    code = "f=open('/flash/boot.py','wb')\n"
    for i in range(0, len(ours), 48):
        code += "f.write(%r)\n" % ours[i:i+48]
    code += "f.close()\nprint('WROTE')\n"
    out = raw(code, 30)
    if 'WROTE' not in out: raise SystemExit('writing failed: ' + out[-300:])
after = fetch('/flash/boot.py')
same = after == ours
print('on the camera now: %d bytes, sha256 %s, %s' % (len(after), hashlib.sha256(after).hexdigest()[:12], 'the same as firmware/k210/boot.py' if same else 'DIFFERENT from firmware/k210/boot.py'))
if not same: raise SystemExit(1)
s.write(b'\x04'); print('restarted:', read(4).decode('utf-8', 'replace').strip()[-160:].replace('\r', ''))
s.close()

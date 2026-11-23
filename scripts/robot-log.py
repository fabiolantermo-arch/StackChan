# The robot's USB log, written to a file with the time of each line, for as long as asked.
# Use (with the ESP-IDF Python, which has pyserial):
#   work/espressif-tools/python_env/idf6.1_py3.14_env/bin/python scripts/robot-log.py /dev/cu.usbmodem101 <file> <seconds>
# Opening the port restarts the robot, whatever is done with the reset lines (seen on 21 Nov 2026). So to look at the
# robot more than once, leave this running in the background for hours and read the file: reading it restarts
# nothing. Stop it (pkill -f robot-log.py) before esptool, which needs the port.
import sys, time, serial
port, out, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])
s = serial.Serial()
s.port = port; s.baudrate = 115200; s.timeout = 0.2
s.dtr = False; s.rts = False
s.open()
start = time.time(); buf = b''
with open(out, 'w', buffering=1) as f:
    while time.time() - start < seconds:
        try: data = s.read(4096)
        except Exception as e:
            # The cable was pulled. Not opened again from here: opening the port restarts the robot, and on 21 Nov 2026
            # (12:35) plugging the cable back in restarted it that way, to the owner's surprise. The log ends here.
            f.write(time.strftime('%H:%M:%S ') + '[porta persa: ' + str(e)[:60] + '; registro chiuso]\n'); break
        if not data: continue
        buf += data
        while b'\n' in buf:
            line, buf = buf.split(b'\n', 1)
            f.write(time.strftime('%H:%M:%S ') + line.decode('utf-8', 'replace').rstrip('\r') + '\n')

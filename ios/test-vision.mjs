// Uses production Vision detector on synthetic image data. No camera is opened.
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
const base=new URL('./',import.meta.url),source=await readFile(new URL('Robottino/RobotLive.swift',base),'utf8');
const start=source.indexOf('final class RobotFaceDetector:'),end=source.indexOf('@MainActor final class RobotPhoneMedia');
if(start<0||end<start)throw Error('Vision source boundary missing');
const temp=await mkdtemp(path.join(tmpdir(),'robottino-vision-'));
const production=path.join(temp,'Detector.swift'),main=path.join(temp,'main.swift'),binary=path.join(temp,'test');
await writeFile(production,'import Foundation\nimport AVFoundation\nimport Vision\nimport QuartzCore\n'+source.slice(start,end));
await writeFile(main,`import Foundation
import CoreGraphics
let detector = RobotFaceDetector()
var poses = 0, missing = 0, failures = 0
detector.onPose = { _ in poses += 1 }; detector.onMissing = { missing += 1 }; detector.onFailure = { failures += 1 }
let bytes = [UInt8](repeating: 0, count: 320 * 240 * 4)
let provider = CGDataProvider(data: Data(bytes) as CFData)!
let image = CGImage(width: 320, height: 240, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 1280, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
detector.robotFrame(image)
precondition(poses == 0 && missing == 1 && failures == 0, "An empty robot frame must never actuate face or head")
detector.robotFrame(image)
precondition(missing == 1, "Detector must throttle bursts rather than queue obsolete frames")
print("PASS production Vision detector accepts CGImage robot input, reports no face and throttles bursts without opening a camera")
`);
const args=['swiftc','-swift-version','5','-module-cache-path',path.join(temp,'cache'),new URL('Robottino/RobotLiveCore.swift',base).pathname,production,main,'-o',binary];
const compile=spawnSync('xcrun',args,{stdio:'inherit'});if(compile.status!==0)process.exit(compile.status??1);
const run=spawnSync(binary,[],{stdio:'inherit'});process.exit(run.status??1);

// The curly redhead (owner, 23 Nov 2026: «ti do una nuova mascotte da disegnare… trovi tutto in
// Looi/immagini/rossa-60-espressioni-e-risveglio… deve essere selezionabile dall'app»). The source pictures are
// 1672×941, all with the head in the same place (the hair differs by a few levels at most from one to the other), on
// black. Each is cut to the same 4:3 window (CROP) and made 320×240 for the robot and the app.
// Writes into firmware/stackchan-mod/assets/:
//   curly-<frame>.png      neutral, happy, sad, blink, angry, scared (the whole screen)
//   curly-mouth-<n>.png    the five mouths for talking over the serene face (mouth-open-10…80; the widest, 100, is a
//                          yawn more than a word), box MOUTH
//   curly-wake-<n>.png     the eyes opening when Robottino wakes (blink-closed, three quarters, half, quarter), box EYES
// and into ios/Robottino/Assets.xcassets/Face-Curly-<frame>.imageset/face.png the app's six: neutral, happy, sad, blink,
// talk-small (mouth-open-25), talk-open (mouth-open-60), the mouth on the serene face as the robot draws it.
// Prints the boxes to copy into portrait-state.js. Run from the repository root:
//   swift firmware/stackchan-mod/prepare-curly.swift [folder for a check picture]
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let source = NSString(string: "~/Documents/Looi/immagini/rossa-60-espressioni-e-risveglio/").expandingTildeInPath + "/"
let assets = "firmware/stackchan-mod/assets/"
let app = "ios/Robottino/Assets.xcassets/"
let check = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : nil
let CROP = CGRect(x: 336, y: 55, width: 1000, height: 750) // in the source, from the top left
let W = 320, H = 240

func load(_ name: String) -> CGImage {
    guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: source + name + ".png") as CFURL, nil),
          let i = CGImageSourceCreateImageAtIndex(s, 0, nil), i.width == 1672, i.height == 941 else { fatalError("\(name).png: missing or not 1672×941") }
    return i
}
// The 320×240 picture as RGBA bytes, rows from the top.
func small(_ name: String) -> [UInt8] {
    let c = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    c.interpolationQuality = .high
    c.draw(load(name).cropping(to: CROP)!, in: CGRect(x: 0, y: 0, width: W, height: H))
    return Array(UnsafeBufferPointer(start: c.data!.assumingMemoryBound(to: UInt8.self), count: W * H * 4))
}
func image(_ px: [UInt8], _ w: Int, _ h: Int) -> CGImage {
    var data = px
    let c = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    return c.makeImage()!
}
func write(_ img: CGImage, _ path: String) {
    let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(d, img, nil); if !CGImageDestinationFinalize(d) { fatalError("cannot write \(path)") }
}
struct Box { var left, top, width, height: Int }
// Where these pictures differ from the serene face, inside a search area: the box (with a margin) that holds it all.
func changed(_ names: [String], within area: Box, level: Int = 40, margin: Int = 4) -> Box {
    let base = small("neutral")
    var x0 = W, y0 = H, x1 = 0, y1 = 0
    for n in names {
        let p = small(n)
        for y in area.top..<(area.top + area.height) { for x in area.left..<(area.left + area.width) {
            let i = (y * W + x) * 4
            if (0..<3).map({ abs(Int(p[i + $0]) - Int(base[i + $0])) }).reduce(0, +) > level { x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y) }
        } }
    }
    x0 = max(0, x0 - margin); y0 = max(0, y0 - margin); x1 = min(W - 1, x1 + margin); y1 = min(H - 1, y1 + margin)
    return Box(left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1)
}
// The box of a picture, its edge (feather points) faded into the serene face so that no seam shows over it.
func piece(_ name: String, _ b: Box, feather: Int = 3) -> [UInt8] {
    let p = small(name), base = small("neutral")
    var out = [UInt8](repeating: 255, count: b.width * b.height * 4)
    for y in 0..<b.height { for x in 0..<b.width {
        let edge = min(x, y, b.width - 1 - x, b.height - 1 - y), a = min(1, Double(edge) / Double(feather))
        let i = ((b.top + y) * W + b.left + x) * 4, o = (y * b.width + x) * 4
        for c in 0..<3 { out[o + c] = UInt8((Double(p[i + c]) * a + Double(base[i + c]) * (1 - a)).rounded()) }
    } }
    return out
}
func onNeutral(_ name: String, _ b: Box) -> [UInt8] {
    var out = small("neutral"); let part = piece(name, b)
    for y in 0..<b.height { for x in 0..<b.width { let i = ((b.top + y) * W + b.left + x) * 4, o = (y * b.width + x) * 4; for c in 0..<3 { out[i + c] = part[o + c] } } }
    return out
}

let frames = ["neutral": "neutral", "happy": "happy", "sad": "sad", "blink": "blink-closed", "angry": "angry", "scared": "surprised"]
for (frame, name) in frames { write(image(small(name), W, H), assets + "curly-\(frame).png") }
let mouths = ["mouth-open-10", "mouth-open-25", "mouth-open-40", "mouth-open-60", "mouth-open-80"]
let MOUTH = changed(mouths, within: Box(left: 110, top: 165, width: 100, height: 70))
for (n, name) in mouths.enumerated() { write(image(piece(name, MOUTH), MOUTH.width, MOUTH.height), assets + "curly-mouth-\(n + 1).png") }
let eyes = ["blink-closed", "blink-three-quarters", "blink-half", "blink-quarter"]
let EYES = changed(eyes, within: Box(left: 90, top: 100, width: 140, height: 70))
for (n, name) in eyes.enumerated() { write(image(piece(name, EYES), EYES.width, EYES.height), assets + "curly-wake-\(n).png") }
// The app: the six expressions, the talking ones with the robot's own mouth on the serene face.
let appFrames: [(String, [UInt8])] = [("neutral", small("neutral")), ("happy", small("happy")), ("sad", small("sad")), ("blink", small("blink-closed")),
                                     ("talk-small", onNeutral("mouth-open-25", MOUTH)), ("talk-open", onNeutral("mouth-open-60", MOUTH))]
for (frame, px) in appFrames {
    let folder = app + "Face-Curly-\(frame).imageset/"
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    write(image(px, W, H), folder + "face.png")
    try #"{"images":[{"filename":"face.png","idiom":"universal"}],"info":{"author":"xcode","version":1}}"#.write(toFile: folder + "Contents.json", atomically: true, encoding: .utf8)
}
print("MOUTH_BOXES curly: {left:\(MOUTH.left),top:\(MOUTH.top),width:\(MOUTH.width),height:\(MOUTH.height)}")
print("WAKE_BOXES curly: {left:\(EYES.left),top:\(EYES.top),width:\(EYES.width),height:\(EYES.height)}")
if let folder = check {
    // The serene face with each mouth and each opening of the eyes, three times larger, to look at.
    let shots: [[UInt8]] = mouths.map { onNeutral($0, MOUTH) } + eyes.map { onNeutral($0, EYES) }
    let c = CGContext(data: nil, width: W * 5, height: H * 2, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    for (i, px) in shots.enumerated() { c.draw(image(px, W, H), in: CGRect(x: (i % 5) * W, y: (1 - i / 5) * H, width: W, height: H)) }
    write(c.makeImage()!, folder + "/curly-check.png")
}

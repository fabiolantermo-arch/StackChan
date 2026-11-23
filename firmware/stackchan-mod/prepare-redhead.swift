// The red-haired face, from the eight pictures the owner sent on 16 Nov 2026 («usa queste nuove immagini per la
// ragazza rossa»): assets/red-source/<pose>.png, each 2560×1920 (eight times the screen), the whole hair in the
// picture, bun included. Writes the eight 320×240 pictures assets/red-<pose>.png:
//   neutral, happy, sad, blink, talk-small, talk-open (robot and iPhone app), angry, scared (robot only).
// The serene picture (neutral) is taken whole, one screen pixel for every 8×8 of the source.
// In the other seven the hair is drawn another way each time (other curls, another outline) and the head is not at
// the same place, so shown whole the hair would change at every blink. From each of them only the face is taken:
// - first it is moved and scaled so that its pupils fall on the serene picture's pupils (PUPILS: measured in the
//   sources; the picture with the eyes closed has none, its shift is measured on nose and cheeks);
// - then only a rounded box inside the skin (brows, eyes, nose, mouth: FACE) is laid over the serene picture, with a
//   soft passage; hair, ears, neck and background are the serene picture's, the same pixels in all eight;
// - of the two talking pictures only the oval of the mouth is taken (MOUTH), so that only the mouth moves.
// The shapes of the lips (owner, 16 Nov 2026, five more pictures of the same size: «nuove espressioni per migliorare
// movimenti labbra»): assets/red-source/lips-<shape>.png, in this order (the number is the one the Worker sends and
// the robot shows, portrait-state.js LIPS): 1 mbp (lips pressed: m, b, p), 2 o (round), 3 u (narrow, forward),
// 4 ei (wide, teeth showing), 5 fv (teeth on the lower lip). They are drawn on the serene picture itself (their
// pupils are within 3 source pixels of its own: taken as they are), so only the oval of the mouth is laid over the
// serene face, as for the talking pictures, and only its box is written: assets/red-lips-<n>.png, and
// red-lips-<n>h.png, half way between the serene mouth and the shape (shown for an instant on the way to it).
// The box is printed for portrait-state.js LIPS_BOXES.
// After this: prepare-mouth-poses.swift, prepare-mood-mouths.swift, prepare-wake-eyes.swift, prepare-call-dot.swift,
// and the six pictures of the app copied to ios/…/Face-Red-<pose>.imageset/face.png (identical to the robot's).
// Run from the repository root: swift firmware/stackchan-mod/prepare-redhead.swift [check-folder]
// With a folder, also writes there each pose whole (only moved and scaled), to see what the box leaves out.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let assets = "firmware/stackchan-mod/assets/", sources = assets + "red-source/"
let W = 320, H = 240, K = 8, SW = W * K, SH = H * K
struct Picture { var px: [Double] } // 320×240, three colours a pixel
func source(_ name: String) -> [UInt8] {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: sources + name + ".png") as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, nil), image.width == SW, image.height == SH else { fatalError("\(name).png: missing or not \(SW)×\(SH)") }
    var data = [UInt8](repeating: 0, count: SW * SH * 4)
    let ctx = CGContext(data: &data, width: SW, height: SH, bitsPerComponent: 8, bytesPerRow: SW * 4, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: SW, height: SH))
    return data
}
// Pupils (left, right as seen) in the source pictures, their own pixels: the middle of the black disc.
// blink: no pupils; nose and cheeks sit 1 pixel right and 9 lower than in the serene picture, at the same size.
let PUPILS: [String: ((Double, Double), (Double, Double))] = [
    "neutral": ((1095.5, 1094.5), (1506.0, 1088.1)),
    "happy": ((1104.3, 1085.9), (1512.4, 1082.7)),
    "sad": ((1090.9, 1091.7), (1501.5, 1095.7)),
    "blink": ((1096.5, 1103.5), (1507.0, 1097.1)),
    "talk-small": ((1088.3, 1093.3), (1519.6, 1087.6)),
    "talk-open": ((1094.2, 1071.7), (1506.5, 1067.5)),
    "angry": ((1081.2, 1125.4), (1502.2, 1122.9)),
    "scared": ((1088.5, 1093.6), (1506.3, 1094.5)),
]
func middle(_ name: String) -> (x: Double, y: Double, apart: Double) {
    let p = PUPILS[name]!
    return ((p.0.0 + p.1.0) / 2, (p.0.1 + p.1.1) / 2, hypot(p.1.0 - p.0.0, p.1.1 - p.0.1))
}
// The pose at 320×240, its pupils on the serene picture's: every screen pixel is the mean of the 8×8 points it covers,
// each read where it is in the pose's own source. Beyond the source's edge the last pixel goes on (background).
func placed(_ name: String, pupils: String? = nil) -> Picture {
    let data = source(name), to = middle("neutral"), from = middle(pupils ?? name), k = from.apart / to.apart
    var out = [Double](repeating: 0, count: W * H * 3)
    for y in 0..<H { for x in 0..<W {
        var sum = [0.0, 0.0, 0.0]
        for j in 0..<K { for i in 0..<K {
            let nx = Double(x * K + i) + 0.5, ny = Double(y * K + j) + 0.5
            let sx = from.x + (nx - to.x) * k - 0.5, sy = from.y + (ny - to.y) * k - 0.5
            let x0 = max(0, min(SW - 2, Int(sx.rounded(.down)))), y0 = max(0, min(SH - 2, Int(sy.rounded(.down))))
            let fx = max(0, min(1, sx - Double(x0))), fy = max(0, min(1, sy - Double(y0)))
            for c in 0..<3 {
                func v(_ X: Int, _ Y: Int) -> Double { Double(data[(Y * SW + X) * 4 + c]) }
                sum[c] += (v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx) * (1 - fy) + (v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx) * fy
            }
        } }
        for c in 0..<3 { out[(y * W + x) * 3 + c] = sum[c] / Double(K * K) }
    } }
    return Picture(px: out)
}
func write(_ p: Picture, _ path: String) {
    var bytes = [UInt8](repeating: 255, count: W * H * 4)
    for i in 0..<W * H { for c in 0..<3 { bytes[i * 4 + c] = UInt8(max(0, min(255, p.px[i * 3 + c].rounded()))) } }
    let ctx = CGContext(data: &bytes, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dst, ctx.makeImage()!, nil); if !CGImageDestinationFinalize(dst) { fatalError("cannot write \(path)") }
}
// How much of the pose shows at (x, y): 1 inside the shape, 0 outside, a soft passage over the last `soft` of it.
// power 2: an oval; 4: a box with round corners. narrow, from: how much narrower the shape is at its bottom than at
// the row `from` (a chin is narrower than the cheeks).
struct Shape { let cx: Double, cy: Double, rx: Double, ry: Double, soft: Double, power: Double; var narrow = 0.0, from = 0.0 }
func weight(_ s: Shape, _ x: Int, _ y: Int) -> Double {
    let down = max(0, (Double(y) - s.from) / (s.cy + s.ry - s.from)), wide = s.rx * (1 - s.narrow * down)
    let dx = abs(Double(x) - s.cx) / wide, dy = abs(Double(y) - s.cy) / s.ry, r = pow(pow(dx, s.power) + pow(dy, s.power), 1 / s.power)
    let m = max(0, min(1, (1 - r) / s.soft)); return m * m * (3 - 2 * m)
}
// A jaw is not the same in every pose (the angry one is slimmer): where the shape would reach the edge of the face in
// either picture, the pose's edge would show as a line across the serene cheek, or the serene one's across the
// pose's. So the shape also stays off the background: nothing within 2 pixels of a background pixel of either
// picture, everything from 7 pixels on.
// Background: the blue around the head (about 10, 30, 70), reached from the edges of the picture through blue alone.
// The dark of a pupil is bluish too, but it is an island inside the face: not counted.
func background(_ p: Picture) -> [Bool] {
    func blue(_ i: Int) -> Bool { p.px[i * 3 + 2] > p.px[i * 3] + 20 && p.px[i * 3] < 110 }
    var found = [Bool](repeating: false, count: W * H), queue: [Int] = []
    for x in 0..<W { queue.append(x); queue.append((H - 1) * W + x) }
    for y in 0..<H { queue.append(y * W); queue.append(y * W + W - 1) }
    while let i = queue.popLast() {
        if found[i] || !blue(i) { continue }
        found[i] = true
        let x = i % W, y = i / W
        if x > 0 { queue.append(i - 1) }; if x < W - 1 { queue.append(i + 1) }; if y > 0 { queue.append(i - W) }; if y < H - 1 { queue.append(i + W) }
    }
    return found
}
func inside(_ a: [Bool], _ b: [Bool], _ x: Int, _ y: Int) -> Double {
    let reach = 7; var nearest = Double(reach)
    for dy in -reach...reach { for dx in -reach...reach {
        let X = x + dx, Y = y + dy, d = hypot(Double(dx), Double(dy))
        if d < nearest, X >= 0, X < W, Y >= 0, Y < H, a[Y * W + X] || b[Y * W + X] { nearest = d }
    } }
    let m = max(0, min(1, (nearest - 2) / 5)); return m * m * (3 - 2 * m)
}
func over(_ base: Picture, _ pose: Picture, _ s: Shape) -> Picture {
    var out = base
    let around = background(base), aroundPose = background(pose)
    // No hole in the face: eyes and mouth are far from any background (boxes: the eyes, the lips).
    for (xs, ys) in [(122..<205, 125..<150), (147..<182, 188..<206)] { for y in ys { for x in xs where inside(around, aroundPose, x, y) < 1 {
        fatalError("background found inside the face at \(x), \(y)") } } }
    for y in 0..<H { for x in 0..<W {
        var w = weight(s, x, y); if w == 0 { continue }
        w *= inside(around, aroundPose, x, y); if w == 0 { continue }
        for c in 0..<3 { let i = (y * W + x) * 3 + c; out.px[i] = base.px[i] * (1 - w) + pose.px[i] * w }
    } }
    return out
}
// The face: from above the brows to the chin, between the cheeks, inside the skin of the serene picture and of the
// pose (the pupils are at (137, 137) and (188, 136), the mouth at y 199, the chin at 221).
let FACE: [String: Shape] = [
    "happy": Shape(cx: 163, cy: 160, rx: 49, ry: 56, soft: 0.16, power: 4, narrow: 0.35, from: 170),
    "sad": Shape(cx: 163, cy: 160, rx: 49, ry: 56, soft: 0.16, power: 4, narrow: 0.35, from: 170),
    "blink": Shape(cx: 163, cy: 160, rx: 49, ry: 56, soft: 0.16, power: 4, narrow: 0.35, from: 170),
    "angry": Shape(cx: 163, cy: 160, rx: 49, ry: 56, soft: 0.16, power: 4, narrow: 0.35, from: 170),
    "scared": Shape(cx: 163, cy: 160, rx: 49, ry: 56, soft: 0.16, power: 4, narrow: 0.35, from: 170),
]
// The mouth of the talking pictures: from under the nose to the chin, past the corners of the lips; whole inside
// 80% of the oval, soft only near its edge.
let MOUTH = Shape(cx: 164, cy: 199, rx: 37.5, ry: 24.5, soft: 0.2, power: 2)

let check = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] + "/" : nil
let neutral = placed("neutral")
write(neutral, assets + "red-neutral.png")
var talking: [String: Picture] = [:]
for name in ["happy", "sad", "blink", "angry", "scared", "talk-small", "talk-open"] {
    let pose = placed(name)
    if let check { write(pose, check + "whole-" + name + ".png") }
    let made = over(neutral, pose, FACE[name] ?? MOUTH)
    if FACE[name] == nil { talking[name] = made }
    write(made, assets + "red-" + name + ".png")
}
// The shapes of the lips.
let shapes = ["mbp", "o", "u", "ei", "fv"].map { over(neutral, placed("lips-" + $0, pupils: "neutral"), MOUTH) }
// The box: every pixel where a shape differs from the serene face, plus 2 pixels; even left edge and width.
var left = W, top = H, right = -1, bottom = -1
for y in 0..<H { for x in 0..<W {
    let i = (y * W + x) * 3
    if (shapes + Array(talking.values)).contains(where: { p in (0..<3).contains { abs(p.px[i + $0].rounded() - neutral.px[i + $0].rounded()) > 6 } }) {
        left = min(left, x); right = max(right, x); top = min(top, y); bottom = max(bottom, y) }
} }
left = max(0, left - 2) & ~1; top = max(0, top - 2); right = min(W - 1, right + 2); bottom = min(H - 1, bottom + 2)
let boxW = (right - left + 2) & ~1, boxH = bottom - top + 1
func writeBox(_ p: Picture, _ path: String) {
    var bytes = [UInt8](repeating: 255, count: boxW * boxH * 4)
    for y in 0..<boxH { for x in 0..<boxW { for c in 0..<3 {
        bytes[(y * boxW + x) * 4 + c] = UInt8(max(0, min(255, p.px[((top + y) * W + left + x) * 3 + c].rounded()))) } } }
    let ctx = CGContext(data: &bytes, width: boxW, height: boxH, bitsPerComponent: 8, bytesPerRow: boxW * 4, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dst, ctx.makeImage()!, nil); if !CGImageDestinationFinalize(dst) { fatalError("cannot write \(path)") }
}
func between(_ a: Picture, _ b: Picture) -> Picture { var m = a; for i in 0..<m.px.count { m.px[i] = (a.px[i] + b.px[i]) / 2 }; return m }
for (n, shape) in shapes.enumerated() {
    writeBox(shape, assets + "red-lips-\(n + 1).png"); writeBox(between(shape, neutral), assets + "red-lips-\(n + 1)h.png")
    if let check { write(shape, check + "lips-\(n + 1).png") }
}
// The pictures in between (owner, 17 Nov 2026: «rendi più realistico il movimento della bocca»): the lips went from a
// shape to another, or to the mouth that follows the loudness, in one cut. Half way between every two of the shapes
// shown whole (1, 2, 3, 5; the wide 4 only ever shows its half-way picture) and between each of them and the two
// talking mouths (6 = talk-small, 7 = talk-open): red-lips-<a><b>.png, the lower number first, shown for an instant on
// the way from one to the other (voice-device.js).
let whole = [1, 2, 3, 5]
for (i, a) in whole.enumerated() {
    for b in whole[(i + 1)...] { writeBox(between(shapes[a - 1], shapes[b - 1]), assets + "red-lips-\(a)\(b).png") }
    writeBox(between(shapes[a - 1], talking["talk-small"]!), assets + "red-lips-\(a)6.png")
    writeBox(between(shapes[a - 1], talking["talk-open"]!), assets + "red-lips-\(a)7.png")
}
print("lips: {left:\(left),top:\(top),width:\(boxW),height:\(boxH)}")
print("Prepared eight 320×240 red-haired pictures and five shapes of the lips from assets/red-source. No firmware or cloud changes.")

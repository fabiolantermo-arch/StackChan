// Robot mouth poses (9 Nov 2026). On the robot the whole 320×240 picture was swapped at every mouth change:
// a full-screen redraw, three positions only, so the lips moved in jerks. The talking pictures differ from
// the serene face only around the mouth, so the robot now draws the serene face once and changes only a
// small picture of the mouth over it, in four openings. Each opening is exactly what the iPhone app shows
// at that openness (RobotLive.swift: talk-small faded in over 0.03…0.33, talk-open over 0.35…0.80):
//   1 = openness .18 (half talk-small), 2 = .35 (talk-small), 3 = .58 (talk-open at 51%), 4 = .80 (talk-open).
// The white robot is a drawing with sharp outlines: a fade shows two mouths at once, so it keeps only its
// two drawn mouths (2 = talk-small, 4 = talk-open; portrait-state.js MOUTH_IMAGES).
// Writes assets/<style>mouth-N.png (no transparency: drawn fast) and prints the box of each style for
// portrait-state.js MOUTH_BOXES. With a path argument, also writes an enlarged side-by-side check.
// Run from the repository root: swift firmware/stackchan-mod/prepare-mouth-poses.swift [check.png]
import AppKit

let assets = "firmware/stackchan-mod/assets/"
let width = 320, height = 240
struct Pixels { var data: [UInt8] }
func load(_ name: String) -> Pixels {
    guard let image = NSImage(contentsOfFile: assets + name)?.cgImage(forProposedRect: nil, context: nil, hints: nil),
          image.width == width, image.height == height else { fatalError("\(name): missing or not 320×240") }
    var data = [UInt8](repeating: 0, count: width * height * 4)
    let context = CGContext(data: &data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return Pixels(data: data)
}
func mix(_ a: Pixels, _ b: Pixels, _ amount: Double) -> Pixels {
    Pixels(data: zip(a.data, b.data).map { UInt8((Double($0) * (1 - amount) + Double($1) * amount).rounded()) })
}
func image(_ pixels: Pixels, _ box: CGRect) -> CGImage {
    let x = Int(box.minX), y = Int(box.minY), w = Int(box.width), h = Int(box.height)
    var crop = [UInt8](repeating: 255, count: w * h * 4)
    for row in 0..<h { for column in 0..<w { for c in 0..<3 { crop[(row * w + column) * 4 + c] = pixels.data[((y + row) * width + x + column) * 4 + c] } } }
    let context = CGContext(data: &crop, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    return context.makeImage()!
}
func write(_ image: CGImage, _ path: String) {
    let rep = NSBitmapImageRep(cgImage: image); rep.hasAlpha = false
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}
var check: [(String, [CGImage])] = []
for (style, prefix) in [("portrait", "girl-"), ("white", "white-"), ("redhead", "red-")] {
    let neutral = load(prefix + "neutral.png"), small = load(prefix + "talk-small.png"), open = load(prefix + "talk-open.png"), blink = load(prefix + "blink.png")
    // The mouth box: every pixel where a talking picture differs from the serene face, plus 2 pixels.
    var left = width, top = height, right = -1, bottom = -1
    for y in 0..<height { for x in 0..<width {
        let i = (y * width + x) * 4
        let differs = (0..<3).contains { c in max(abs(Int(small.data[i + c]) - Int(neutral.data[i + c])), abs(Int(open.data[i + c]) - Int(neutral.data[i + c]))) > 6 }
        if differs { left = min(left, x); right = max(right, x); top = min(top, y); bottom = max(bottom, y) }
    } }
    guard right >= 0 else { fatalError("\(style): talking pictures equal to the serene face") }
    left = max(0, left - 2) & ~1; top = max(0, top - 2); right = min(width - 1, right + 2); bottom = min(height - 1, bottom + 2)
    let box = CGRect(x: left, y: top, width: (right - left + 2) & ~1, height: bottom - top + 1)
    // Outside the box the pictures must not differ, and the box must look the same over the blinking face.
    var outside = 0, blinkDiff = 0, translucent = 0
    for y in 0..<height { for x in 0..<width {
        let i = (y * width + x) * 4, inside = box.contains(CGPoint(x: x, y: y))
        for picture in [neutral, small, open, blink] where picture.data[i + 3] != 255 { translucent += 1 }
        for c in 0..<3 {
            let d = max(abs(Int(small.data[i + c]) - Int(neutral.data[i + c])), abs(Int(open.data[i + c]) - Int(neutral.data[i + c])))
            if !inside { outside = max(outside, d) } else { blinkDiff = max(blinkDiff, abs(Int(blink.data[i + c]) - Int(neutral.data[i + c]))) }
        }
    } }
    let faded = style != "white"
    let poses = [(1, faded ? mix(neutral, small, 0.5) : nil), (2, small), (3, faded ? mix(small, open, (0.58 - 0.35) / 0.45) : nil), (4, open)]
        .compactMap { index, pixels in pixels.map { (index, image($0, box)) } }
    for (index, pose) in poses { write(pose, assets + "\(prefix)mouth-\(index).png") }
    print("\(style): {left:\(Int(box.minX)),top:\(Int(box.minY)),width:\(Int(box.width)),height:\(Int(box.height))}  outside the box up to \(outside), blink differs up to \(blinkDiff) inside, translucent pixels \(translucent)")
    check.append((style, [image(neutral, box)] + poses.map { $0.1 }))
}
if CommandLine.arguments.count > 1 {
    // Enlarged ×3: serene mouth, then the four openings, one row per style.
    let scale = 3, gap = 6
    let rowWidth = check.map { $0.1.reduce(0) { $0 + $1.width * scale + gap } }.max()!, rowHeights = check.map { $0.1[0].height * scale + gap }
    let context = CGContext(data: nil, width: rowWidth, height: rowHeights.reduce(0, +), bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(CGColor(gray: 0.15, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: rowWidth, height: rowHeights.reduce(0, +)))
    context.interpolationQuality = .none
    var y = rowHeights.reduce(0, +)
    for (index, (_, images)) in check.enumerated() {
        y -= rowHeights[index]; var x = 0
        for picture in images { context.draw(picture, in: CGRect(x: x, y: y, width: picture.width * scale, height: picture.height * scale)); x += picture.width * scale + gap }
    }
    write(context.makeImage()!, CommandLine.arguments[1])
}

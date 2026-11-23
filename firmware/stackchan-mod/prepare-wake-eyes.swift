// The eyes opening when Robottino wakes up (owner, 14 Nov 2026: «fai tu un'animazione del volto della ragazza che
// passi da occhi chiusi a occhi aperti», «con dissolvenza dal nero iniziale»). Each face has a serene picture
// (<style>neutral) and one with the eyes closed (<style>blink), in the same pose. Between the two, the upper lid
// rises: in the box around the eyes, below a line the eye of the serene picture shows, above it the closed lid of the
// other, and along the line a dark lid edge. The line starts where the closed lashes are and goes up to the top of
// the open eye.
// Writes assets/<style>wake-N.png (N = 0 closed … 3 nearly open; no transparency) for the two girls, the size of the
// eye box, to be drawn over the serene picture (outside the eyes it is the serene picture itself), and prints the boxes for portrait-state.js WAKE_BOXES. With a path argument, also
// writes an enlarged check of all the steps.
// Run from the repository root: swift firmware/stackchan-mod/prepare-wake-eyes.swift [check.png]
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let assets = "firmware/stackchan-mod/assets/"
// How far open each picture is (0 closed, 1 the serene picture).
let steps: [Double] = [0, 0.3, 0.6, 0.85]
struct Picture { let w: Int, h: Int; var px: [UInt8] }
func load(_ name: String) -> Picture {
    let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: assets + name) as CFURL, nil)!
    let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
    guard img.width == 320, img.height == 240 else { fatalError("\(name): not 320×240") }
    let ctx = CGContext(data: nil, width: 320, height: 240, bitsPerComponent: 8, bytesPerRow: 320 * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: 320, height: 240))
    return Picture(w: 320, h: 240, px: Array(UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: 320 * 240 * 4)))
}
func cgImage(_ p: Picture) -> CGImage {
    var px = p.px
    return CGContext(data: &px, width: p.w, height: p.h, bitsPerComponent: 8, bytesPerRow: p.w * 4,
                     space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
}
func write(_ image: CGImage, _ path: String) {
    let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dst, image, nil); if !CGImageDestinationFinalize(dst) { fatalError("cannot write \(path)") }
}
func crop(_ p: Picture, _ box: CGRect) -> CGImage { cgImage(p).cropping(to: box)! }

// Where the two pictures differ (the eyes): rows `rows` only, so that nothing lower (the mouth) counts.
func difference(_ a: Picture, _ b: Picture, _ x: Int, _ y: Int) -> Int {
    let i = (y * a.w + x) * 4
    return abs(Int(a.px[i]) - Int(b.px[i])) + abs(Int(a.px[i + 1]) - Int(b.px[i + 1])) + abs(Int(a.px[i + 2]) - Int(b.px[i + 2]))
}
// One eye: for every column, where the open eye begins (top) and where the closed lashes end (bottom), both smoothed
// so that the lid's line is a clean curve; the columns it covers (with a soft edge outside them).
struct Eye { let from: Int; let to: Int; var top: [Int: Double]; var bottom: [Int: Double] }
struct Eyes { let box: CGRect; let eyes: [Eye] }
func smooth(_ values: [Int: Double], _ from: Int, _ to: Int, _ reach: Int) -> [Int: Double] {
    var out = [Int: Double]()
    for x in from...to {
        var sum = 0.0, count = 0.0
        for k in (x - reach)...(x + reach) { if let v = values[k] { sum += v; count += 1 } }
        if count > 0 { out[x] = sum / count }
    }
    return out
}
func findEyes(_ open: Picture, _ closed: Picture, rows: ClosedRange<Int>, threshold: Int) -> Eyes {
    var eyes: [Eye] = [], minY = 240, maxY = 0, minX = 320, maxX = 0
    for half in [0..<160, 160..<320] {
        var top = [Int: Double](), bottom = [Int: Double](), from = 320, to = 0
        for x in half {
            // Only columns where enough pixels differ: the eye itself, not a stray hair or a freckle.
            let ys = rows.filter { difference(open, closed, x, $0) > threshold }
            guard ys.count >= 3, let t = ys.min(), let b = ys.max() else { continue }
            top[x] = Double(t); bottom[x] = Double(b); from = min(from, x); to = max(to, x)
        }
        guard to > from else { fatalError("eye not found") }
        let eye = Eye(from: from, to: to, top: smooth(top, from, to, 6), bottom: smooth(bottom, from, to, 6))
        eyes.append(eye)
        minX = min(minX, from); maxX = max(maxX, to)
        minY = min(minY, Int(eye.top.values.min()!)); maxY = max(maxY, Int(eye.bottom.values.max()!.rounded(.up)))
    }
    let margin = 6, left = max(0, minX - margin), topY = max(0, minY - margin)
    let width = min(320 - left, (maxX - minX + 2 * margin + 2) / 2 * 2), height = min(240 - topY, (maxY - minY + 2 * margin + 2) / 2 * 2)
    return Eyes(box: CGRect(x: left, y: topY, width: width, height: height), eyes: eyes)
}
// The step `amount` (0 closed … 1 open), drawn over the serene picture: inside each eye, the open eye below the lid's
// line and the closed lid above it, with a dark edge along the line; around the eye a soft passage to the serene
// picture (whose eyebrows stay: the closed picture's are a little lower).
func wake(_ open: Picture, _ closed: Picture, _ eyes: Eyes, _ amount: Double, lid: (Double, Double, Double)) -> Picture {
    var out = open
    let feather = 4.0
    for eye in eyes.eyes {
        for x in max(0, eye.from - 6)...min(319, eye.to + 6) {
            let k = min(max(x, eye.from), eye.to)
            guard let t = eye.top[k], let b = eye.bottom[k] else { continue }
            // How much of the closed picture this column takes: all inside the eye, less towards its corners.
            let side = x < eye.from ? Double(eye.from - x) : x > eye.to ? Double(x - eye.to) : 0
            let inX = max(0, 1 - side / feather)
            let line = b - amount * (b - t)
            for y in Int(t - feather - 2)...Int(b + feather + 2) where y >= 0 && y < 240 {
                let yy = Double(y)
                let outside = yy < t ? t - yy : yy > b ? yy - b : 0
                let inside = inX * max(0, 1 - outside / feather)
                // Below the line the open eye shows (over 2 pixels), above it the closed lid.
                let lidPart = amount <= 0 ? 1 : max(0, min(1, (line - yy + 1) / 2))
                let closedPart = inside * lidPart
                let edge = amount <= 0 || amount >= 1 ? 0 : inX * max(0, 1 - abs(yy - line + 0.5) / 2) * 0.7
                let i = (y * 320 + x) * 4
                for c in 0..<3 {
                    var v = Double(open.px[i + c]) * (1 - closedPart) + Double(closed.px[i + c]) * closedPart
                    let dark = c == 0 ? lid.0 : c == 1 ? lid.1 : lid.2
                    v = v * (1 - edge) + dark * edge
                    out.px[i + c] = UInt8(max(0, min(255, v.rounded())))
                }
            }
        }
    }
    return out
}

// style, rows where the eyes are (above the mouth), difference that counts, colour of the lid's edge.
// The rows of the eyes: below the eyebrows (the blonde's closed picture has them lower), above the nose. The white
// robot's eyes are drawn differently open and closed: it is not animated (its eyes open at once).
let faces: [(String, ClosedRange<Int>, Int, (Double, Double, Double))] = [
    ("girl-", 106...145, 120, (40, 22, 18)),
    ("red-", 122...149, 90, (45, 25, 20)), // 16 Nov 2026: the new pictures, the eyes at y 137
]
var check: [(String, [Picture])] = []
for (style, rows, threshold, lid) in faces {
    let open = load(style + "neutral.png"), closed = load(style + "blink.png")
    let eyes = findEyes(open, closed, rows: rows, threshold: threshold)
    var shown: [Picture] = []
    for (n, amount) in steps.enumerated() {
        let picture = wake(open, closed, eyes, amount, lid: lid)
        // Over the serene picture: outside the box nothing changes, so the picture under it is the serene one.
        write(crop(picture, eyes.box), assets + "\(style)wake-\(n).png")
        shown.append(picture)
    }
    shown.append(open)
    check.append((style, shown))
    print("\(style): {left:\(Int(eyes.box.minX)),top:\(Int(eyes.box.minY)),width:\(Int(eyes.box.width)),height:\(Int(eyes.box.height))}")
}
if CommandLine.arguments.count > 1 {
    // Each face on a row, the steps side by side, the eye area twice as large.
    let zoom = 2, cell = (w: 160 * zoom, h: 70 * zoom)
    let ctx = CGContext(data: nil, width: cell.w * (steps.count + 1), height: cell.h * check.count, bitsPerComponent: 8, bytesPerRow: cell.w * (steps.count + 1) * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .none
    for (row, (style, pictures)) in check.enumerated() {
        let y0 = 85
        for (col, p) in pictures.enumerated() {
            let part = crop(p, CGRect(x: 80, y: y0, width: 160, height: 70))
            ctx.draw(part, in: CGRect(x: col * cell.w, y: (check.count - 1 - row) * cell.h, width: cell.w, height: cell.h))
        }
    }
    write(ctx.makeImage()!, CommandLine.arguments[1])
}

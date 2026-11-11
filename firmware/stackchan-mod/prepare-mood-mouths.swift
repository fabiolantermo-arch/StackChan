// Talking mouths over the angry and sad faces (owner, 11 Nov 2026: «deve parlare con la faccia arrabbiata», then
// «deve parlare con la faccia triste»). While Robottino speaks, the face keeps its angry or sad picture and only a small picture of the mouth changes, in the same four openings
// as the serene face (portrait-state.js MOUTH_POSES: .18, .35, .58, .80). These pictures have no talking poses of
// their own, so the openings are made from the picture itself:
// - the girls: below the line between the lips the lower lip and the chin come down (a lens, widest in the middle,
//   fading out towards the chin), and the gap shows the dark inside of the mouth;
// - the white robot: its drawn frown (angry or sad) becomes an open mouth with the same glowing blue outline, its top still arched.
// Writes assets/<style><mood>-mouth-N.png (no transparency) and prints the boxes for portrait-state.js
// MOOD_MOUTH_BOXES. With a path argument, also writes an enlarged side-by-side check.
// Run from the repository root: swift firmware/stackchan-mod/prepare-mood-mouths.swift [check.png]
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let assets = "firmware/stackchan-mod/assets/"
let openings: [Double] = [0.18, 0.35, 0.58, 0.80]
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
// Box in top-left coordinates. CGImage.cropping uses the same orientation as the pixel rows.
func crop(_ p: Picture, _ box: CGRect) -> CGImage { cgImage(p).cropping(to: box)! }

// The girls. lip: y of the line between the lips; cx, half: centre and half width of the mouth; most: how far the
// lower lip comes down at .80 (pixels); inside: colour of the open mouth.
func girlMouth(_ base: Picture, open: Double, lip: Double, cx: Double, half: Double, most: Double, inside: (Double, Double, Double), box: CGRect) -> Picture {
    var out = base
    func sample(_ x: Double, _ y: Double, _ c: Int) -> Double {
        let x0 = max(0, min(base.w - 2, Int(floor(x)))), y0 = max(0, min(base.h - 2, Int(floor(y)))), fx = x - Double(x0), fy = y - Double(y0)
        func v(_ X: Int, _ Y: Int) -> Double { Double(base.px[(Y * base.w + X) * 4 + c]) }
        return (v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx) * (1 - fy) + (v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx) * fy
    }
    let drop = most * open / 0.8, fadeTop = lip + 14, bottom = Double(box.maxY) - 2
    for y in Int(box.minY)..<Int(box.maxY) { for x in Int(box.minX)..<Int(box.maxX) {
        let dx = (Double(x) - cx) / (half * 1.08), lens = dx * dx < 1 ? pow(1 - dx * dx, 0.6) : 0
        let fy = Double(y) - lip
        if fy < 0 || lens == 0 { continue }
        // How far this column has come down here: the whole drop up to fadeTop, then less and less to the box's edge.
        let fade = Double(y) <= fadeTop ? 1 : max(0, 1 - (Double(y) - fadeTop) / (bottom - fadeTop))
        let gap = drop * lens, shift = gap * fade
        let i = (y * base.w + x) * 4
        if fy < gap {
            // Inside the mouth: darkest at the top, a little lighter towards the lower lip; soft against both lips and
            // at the corners. (A hint of teeth was tried: at this size it reads as a flickering light line.)
            // Against the upper lip it fades into the picture as it is; against the lower lip into the lower lip as it now
            // is, moved down (fading into the unmoved picture there drew a light dotted line).
            let t = fy / max(1, gap), side = min(1, lens * 2.2), top = min(1, fy / 2.2) * side, low = min(1, (gap - fy) / 2.2) * side
            let shade = 0.65 + 0.35 * t
            let c = [inside.0 * shade, inside.1 * shade, inside.2 * shade]
            for k in 0..<3 {
                let lower = sample(Double(x), Double(y) - shift, k)
                let edge = fy < gap / 2 ? (Double(base.px[i + k]) * (1 - top) + c[k] * top) : (lower * (1 - low) + c[k] * low)
                out.px[i + k] = UInt8(max(0, min(255, edge.rounded())))
            }
        } else {
            for k in 0..<3 { out.px[i + k] = UInt8(max(0, min(255, sample(Double(x), Double(y) - shift, k).rounded()))) }
        }
    }}
    return out
}

// The white robot: an open mouth drawn over its frown, on the black of its screen.
func robotMouth(_ base: Picture, open: Double, cx: CGFloat, line: CGFloat, half: CGFloat, box: CGRect) -> Picture {
    var px = base.px
    let ctx = CGContext(data: &px, width: base.w, height: base.h, bitsPerComponent: 8, bytesPerRow: base.w * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.translateBy(x: 0, y: CGFloat(base.h)); ctx.scaleBy(x: 1, y: -1) // top-left coordinates
    // The frown goes: the mouth area back to the screen's black.
    ctx.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
    ctx.fill(CGRect(x: cx - half - 6, y: line - 12, width: (half + 6) * 2, height: 28))
    let h = CGFloat(3 + open * 15), w = half * CGFloat(0.85 + open * 0.15)
    let path = CGMutablePath()
    path.move(to: CGPoint(x: cx - w, y: line + 2))
    path.addQuadCurve(to: CGPoint(x: cx + w, y: line + 2), control: CGPoint(x: cx, y: line - 7))      // arched top: angry
    path.addQuadCurve(to: CGPoint(x: cx - w, y: line + 2), control: CGPoint(x: cx, y: line - 5 + h * 2))
    path.closeSubpath()
    ctx.addPath(path); ctx.setFillColor(red: 0.55, green: 0.10, blue: 0.16, alpha: 1); ctx.fillPath()
    ctx.setShadow(offset: .zero, blur: 4, color: CGColor(red: 0.2, green: 0.85, blue: 1, alpha: 0.9))
    ctx.addPath(path); ctx.setStrokeColor(red: 0.35, green: 0.9, blue: 1, alpha: 1); ctx.setLineWidth(2.4); ctx.setLineJoin(.round); ctx.strokePath()
    return Picture(w: base.w, h: base.h, px: px)
}

struct Style { let prefix: String; let mood: String; let box: CGRect; let make: (Picture, Double) -> Picture }
// One entry per face and mood. The boxes go in portrait-state.js MOOD_MOUTH_BOXES.
func girl(_ prefix: String, _ mood: String, lip: Double, cx: Double, half: Double, inside: (Double, Double, Double)) -> Style {
    let box = CGRect(x: Int(cx.rounded()) - 35, y: Int(lip) - 14, width: 70, height: 50)
    return Style(prefix: prefix, mood: mood, box: box) { base, open in
        girlMouth(base, open: open, lip: lip, cx: cx, half: half, most: 9, inside: inside, box: box) }
}
func robot(_ mood: String, line: CGFloat) -> Style {
    let box = CGRect(x: 132, y: Int(line) - 16, width: 56, height: 40)
    return Style(prefix: "white-", mood: mood, box: box) { base, open in robotMouth(base, open: open, cx: 160, line: line, half: 15, box: box) }
}
let styles = [
    // Angry: line between the lips measured on the angry pictures.
    girl("girl-", "angry", lip: 190, cx: 165, half: 21, inside: (78, 24, 28)),
    girl("red-", "angry", lip: 190, cx: 164.5, half: 24, inside: (70, 22, 24)),
    robot("angry", line: 172),
    // Sad (owner, 11 Nov 2026: «deve parlare con la faccia triste»): the darkest row between the lips of the sad
    // pictures (girl 194, from x 138 to 187; red 191, from 143 to 183), the white robot's frown from y 153 to 160.
    girl("girl-", "sad", lip: 194, cx: 162.5, half: 22, inside: (78, 24, 28)),
    girl("red-", "sad", lip: 192, cx: 163, half: 23, inside: (70, 22, 24)),
    robot("sad", line: 158),
]
var check: [CGImage] = []
for style in styles {
    let base = load(style.prefix + style.mood + ".png")
    check.append(crop(base, style.box))
    for (n, open) in openings.enumerated() {
        let image = crop(style.make(base, open), style.box)
        write(image, assets + "\(style.prefix)\(style.mood)-mouth-\(n + 1).png"); check.append(image)
    }
    let b = style.box
    print("\(style.prefix)\(style.mood): {left:\(Int(b.minX)),top:\(Int(b.minY)),width:\(Int(b.width)),height:\(Int(b.height))}")
}
if CommandLine.arguments.count > 1 {
    // One row per style: the closed angry mouth, then the four openings, each 4× bigger.
    let cellW = 70 * 4, cellH = 50 * 4, cols = 5 // one row per face and mood
    let ctx = CGContext(data: nil, width: cellW * cols, height: cellH * styles.count, bitsPerComponent: 8, bytesPerRow: cellW * cols * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .none
    for (i, image) in check.enumerated() {
        let row = i / cols, col = i % cols
        ctx.draw(image, in: CGRect(x: col * cellW, y: (styles.count - 1 - row) * cellH, width: image.width * 4, height: image.height * 4))
    }
    write(ctx.makeImage()!, CommandLine.arguments[1])
}
print("Prepared four talking mouths over each angry and sad face. No firmware or cloud changes.")

import Foundation
import SwiftUI

enum RobotLiveError: LocalizedError {
    case offline, invalid, rejected(String), timeout, busy, simulatorCamera
    var errorDescription: String? {
        switch self {
        case .offline: return "Collegamento al robot assente."
        case .invalid: return "Dati del robot non validi. Collegamento chiuso."
        case .rejected(let reason): return "Il robot non ha eseguito il comando (\(reason))."
        case .timeout: return "Il robot non ha confermato il comando in tempo."
        case .busy: return "Attendi il comando precedente."
        case .simulatorCamera: return "Il simulatore non ha fotocamera: sul Mac apri «Simulator Camera.command» nella cartella Robottino, poi riprova."
        }
    }
}
struct RobotLiveStatus: Decodable {
    var connected: Bool
    var hardwareVerified: Bool
    var calibrated: Bool
    var motion: Bool
    var motionEnabled: Bool
    var camera: Bool
    var audio: Bool
    var screen: Bool
    var simulated: Bool?
    /// The robot is in a voice conversation (MOD hello, 9 Nov 2026): the open app then follows the face.
    var conversation: Bool?
}
struct RobotMediaPacket {
    let kind: UInt8
    let sequence: UInt32
    let width: Int
    let height: Int
    let payload: Data
    /// A camera frame rebuilt from its pieces keeps the robot's frame number (face following answers with it).
    var frameID: UInt32 = 0
    func encoded() throws -> Data {
        guard sequence > 0 else { throw RobotLiveError.invalid }
        if kind == 3 {
            guard width == 0, height == 0, payload.count >= 2, payload.count <= 6400, payload.count % 2 == 0 else { throw RobotLiveError.invalid }
        } else if kind == 4 || kind == 5 {
            guard (1...320).contains(width), (1...240).contains(height), (10...32776).contains(payload.count), payload.count % 2 == 0 else { throw RobotLiveError.invalid }
            let header = [UInt8](payload.prefix(8))
            let frame = header.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
            let offset = header.suffix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
            guard frame > 0, offset % 2 == 0, UInt64(offset) + UInt64(payload.count - 8) <= UInt64(width * height * 2) else { throw RobotLiveError.invalid }
        } else if kind == 6 {
            // Face following: grey piece (one byte a pixel, at most 160×120), frame id and byte offset like kind 4.
            guard (1...160).contains(width), (1...120).contains(height), (9...4104).contains(payload.count) else { throw RobotLiveError.invalid }
            let header = [UInt8](payload.prefix(8))
            let frame = header.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
            let offset = header.suffix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
            guard frame > 0, UInt64(offset) + UInt64(payload.count - 8) <= UInt64(width * height) else { throw RobotLiveError.invalid }
        } else if kind == 7 {
            // Only inside the app: a grey frame rebuilt from kind 6 pieces. Never accepted from the network.
            guard (1...160).contains(width), (1...120).contains(height), payload.count == width * height else { throw RobotLiveError.invalid }
        } else {
            guard (kind == 1 || kind == 2), (1...(kind == 1 ? 320 : 160)).contains(width), (1...(kind == 1 ? 240 : 120)).contains(height), payload.count == width * height * 2 else { throw RobotLiveError.invalid }
        }
        var data = Data([0x52,0x42,1,kind,UInt8(sequence >> 24),UInt8((sequence >> 16) & 255),UInt8((sequence >> 8) & 255),UInt8(sequence & 255),UInt8(width >> 8),UInt8(width & 255),UInt8(height >> 8),UInt8(height & 255)])
        data.append(payload); return data
    }
    /// Full-resolution screen image (kind 5): 32 KB pieces, each with frame id and byte offset (big-endian).
    static func screenPieces(frameID: UInt32, pixels: Data) -> [Data] {
        stride(from: 0, to: pixels.count, by: 32768).map { offset in
            var piece = Data([UInt8(frameID >> 24), UInt8((frameID >> 16) & 255), UInt8((frameID >> 8) & 255), UInt8(frameID & 255),
                              UInt8(offset >> 24), UInt8((offset >> 16) & 255), UInt8((offset >> 8) & 255), UInt8(offset & 255)])
            piece.append(pixels.subdata(in: pixels.startIndex + offset..<pixels.startIndex + min(offset + 32768, pixels.count))); return piece
        }
    }
    static func decode(_ data: Data) throws -> RobotMediaPacket {
        guard data.count >= 12, data.count <= 153612 else { throw RobotLiveError.invalid }
        let bytes = [UInt8](data.prefix(12))
        guard bytes[0] == 0x52, bytes[1] == 0x42, bytes[2] == 1 else { throw RobotLiveError.invalid }
        let sequence = UInt32(bytes[4]) << 24 | UInt32(bytes[5]) << 16 | UInt32(bytes[6]) << 8 | UInt32(bytes[7])
        let result = RobotMediaPacket(kind: bytes[3], sequence: sequence, width: Int(bytes[8]) * 256 + Int(bytes[9]), height: Int(bytes[10]) * 256 + Int(bytes[11]), payload: data.subdata(in: 12..<data.count))
        _ = try result.encoded(); return result
    }
}
// At most one frame in RAM. Expired/incomplete frames never reach Vision. Colour pieces (kind 4) become a kind 1
// frame, grey pieces for face following (kind 6) a kind 7 frame. On the iPhone hotspot a colour frame takes about
// 2 s, so a frame may take up to `maxSeconds` to arrive; the robot sends the next one only after this one.
struct RobotVideoAssembler {
    static let maxSeconds = 10.0
    private var frameID: UInt32 = 0
    private var completed: UInt32 = 0
    private var kind: UInt8 = 0
    private var width = 0, height = 0
    private var bytes = Data()
    private var started = 0.0
    mutating func reset() { self = RobotVideoAssembler() }
    mutating func append(_ packet: RobotMediaPacket, now: Double = ProcessInfo.processInfo.systemUptime) throws -> RobotMediaPacket? {
        guard packet.kind == 4 || packet.kind == 6 else { throw RobotLiveError.invalid }
        _ = try packet.encoded()
        let header = [UInt8](packet.payload.prefix(8))
        let id = header.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        let offset = Int(header.suffix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) })
        if offset == 0 {
            guard id > completed, id > frameID || bytes.isEmpty else { throw RobotLiveError.invalid }
            frameID = id; kind = packet.kind; width = packet.width; height = packet.height; bytes = Data(); started = now
            bytes.reserveCapacity(width * height * (kind == 4 ? 2 : 1))
        }
        guard id == frameID else { return nil }
        guard now.isFinite, now >= started, now - started <= Self.maxSeconds else { bytes = Data(); return nil }
        guard kind == packet.kind, width == packet.width, height == packet.height, offset == bytes.count else { throw RobotLiveError.invalid }
        bytes.append(packet.payload.dropFirst(8))
        guard bytes.count == width * height * (kind == 4 ? 2 : 1) else { return nil }
        let result = RobotMediaPacket(kind: kind == 4 ? 1 : 7, sequence: packet.sequence, width: width, height: height, payload: bytes, frameID: id)
        completed = id; bytes = Data(); return result
    }
}

enum RobotFaceSource: String, CaseIterable { case robot, phone }

/// Test page (9 Nov 2026): the joystick moves the real head within the limits of head commands from the
/// iPhone (owner's choice: 46° sideways and 30° up, the robot's own safety limits; src/robot-wire.ts and the
/// MOD), upward only (negative pitch: the K151 cannot look down). The robot also keeps to its calibration.
/// Whole degrees, so a command goes out only when the target really changes.
enum RobotHeadJoystick {
    /// 90° to each side and up to 85° (owner, 9 Nov 2026; the robot's calibration may stop it earlier).
    static let yawLimit = 90, upLimit = 85
    /// Knob position → head angles as shown on the page: positive yaw = to the right of the stick.
    static func target(x: Double, y: Double) -> (yaw: Int, pitch: Int) {
        guard x.isFinite, y.isFinite else { return (0, 0) }
        let yaw = Int((min(1, max(-1, x)) * Double(yawLimit)).rounded()), pitch = Int((min(0, max(-1, y)) * Double(upLimit)).rounded())
        return (yaw == 0 ? 0 : yaw, pitch == 0 ? 0 : pitch)
    }
    /// The `motion` command for the robot. The head moved the wrong way (owner, 9 Nov 2026: «inverti i comandi destra
    /// e sinistra»): the cause was the K151 yaw servo, now reversed in the MOD (calibration.js YAW_SERVO), so the
    /// angles go as they are and every motion, face following included, turns the right way.
    static func command(yaw: Int, pitch: Int) -> [String: Int] { ["yaw": yaw, "pitch": pitch] }
}

/// «Seguimi con la fotocamera dell’iPhone» (owner, 10 Nov 2026): the iPhone stands next to the robot, facing the
/// same way; its front camera sees the face 10 times a second and the head is sent straight to the angle at which
/// the phone sees it (a `motion` command), with no image travelling from the robot (two a second at best).
enum RobotPhoneFollow {
    /// Vision's box of the face in the mirrored front-camera image (0…1, origin at the bottom left) → head angles.
    /// `fieldOfView`: degrees seen along the long side of the image (vertical, with the phone upright);
    /// `aspect`: short side over long side. In the mirrored image a face on the right is on the owner's right,
    /// that is to the right of the stick (positive yaw); a face above the middle is up (negative pitch).
    /// `landscape`: the phone lies on its side, so the long side of the image is the horizontal one.
    /// `tilt`: how many degrees the camera itself looks above the horizon (a phone leaning back against something
    /// sees a face that is well above it in the middle of its image: 10 Nov 2026, «va solo a destra e a sinistra, e
    /// non sale»). It is added to the height at which the camera sees the face.
    static func aim(x: Double, y: Double, width: Double, height: Double, fieldOfView: Double, aspect: Double = 0.75, landscape: Bool = false, tilt: Double = 0) -> (yaw: Int, pitch: Int)? {
        guard [x, y, width, height, fieldOfView, aspect, tilt].allSatisfy(\.isFinite), abs(tilt) <= 90, width > 0, height > 0, width <= 1, height <= 1, fieldOfView >= 20, fieldOfView <= 150, aspect > 0, aspect <= 1 else { return nil }
        let cx = min(1, max(0, x + width / 2)), cy = min(1, max(0, y + height / 2))
        let long = tan(fieldOfView * .pi / 360), tall = landscape ? long * aspect : long, wide = landscape ? long : long * aspect
        let yaw = atan((cx - 0.5) * 2 * wide) * 180 / .pi, pitch = -(atan((cy - 0.5) * 2 * tall) * 180 / .pi + tilt)
        let limited = (yaw: Int(min(Double(RobotHeadJoystick.yawLimit), max(-Double(RobotHeadJoystick.yawLimit), yaw)).rounded()), pitch: Int(min(0, max(-Double(RobotHeadJoystick.upLimit), pitch)).rounded()))
        return (limited.yaw == 0 ? 0 : limited.yaw, limited.pitch == 0 ? 0 : limited.pitch)
    }
    /// Where the head goes when the following starts, before the camera has found the face: up, where the owner's
    /// face usually is (owner, 10 Nov 2026: «all'avvio cerchi il mio viso, che di solito è in alto»).
    static let start = (yaw: 0, pitch: -30)
    /// A new command only for a change the eye would notice: the head does not tremble with the noise of the box.
    static let step = 2
    static func moved(_ next: (yaw: Int, pitch: Int), from last: (yaw: Int, pitch: Int)?) -> Bool {
        guard let last else { return true }
        return abs(next.yaw - last.yaw) >= step || abs(next.pitch - last.pitch) >= step
    }
}

/// Face following during a conversation with the app open (owner, 9 Nov 2026): when it starts and when it stops.
enum RobotConversationFollowRule {
    /// Start only for a real robot in a conversation, with motions and camera ready and no page using the Live channel.
    static func shouldStart(_ status: RobotLiveStatus, enabled: Bool, pageOpen: Bool) -> Bool {
        enabled && !pageOpen && status.connected && status.conversation == true && status.motionEnabled && status.camera && status.simulated != true
    }
    /// Stop when the conversation ends, the motions stop or a page needs the Live channel.
    static func shouldStop(_ status: RobotLiveStatus?, enabled: Bool, pageOpen: Bool) -> Bool {
        guard let status else { return true }
        return !enabled || pageOpen || !status.connected || status.conversation != true || !status.motionEnabled
    }
}

/// «Segui il mio viso» (9 Nov 2026): the robot sends small camera frames, the iPhone finds the face and tells
/// the robot where it is in that frame. The robot turns its head from where it was when it took the frame
/// (firmware `tracker.js` aim), so a late answer does not make it overshoot.
enum RobotFaceFollow {
    /// Vision box (0…1, origin at the bottom left) → face centre in the frame, 0…1 with y from the top, to
    /// 0.001. A face narrower than 6% of the frame is ignored: too far away to follow, or a false match.
    static func target(x: Double, y: Double, width: Double, height: Double) -> (x: Double, y: Double)? {
        guard [x, y, width, height].allSatisfy(\.isFinite), width >= 0.06, width <= 1, height > 0, height <= 1 else { return nil }
        let cx = min(1, max(0, x + width / 2)), cy = min(1, max(0, 1 - (y + height / 2)))
        return ((cx * 1000).rounded() / 1000, (cy * 1000).rounded() / 1000)
    }
    /// Vision's confidence needed to follow a face. 0.8 was too strict for the robot camera: in a real frame (9 Nov 2026,
    /// owner backlit under a ceiling lamp) the face was found at 0.75–0.79 and ignored, so the head never moved.
    static let minimumConfidence: Float = 0.5
    static func accepts(confidence: Float) -> Bool { confidence.isFinite && confidence >= minimumConfidence }
    /// The relay's `track` command (src/robot-wire.ts): whole frame number, x and y.
    static func values(frameID: UInt32, x: Double, y: Double) -> [String: Any] { ["frameId": Int(frameID), "x": x, "y": y] }
}

/// Face following across frames (owner, 9 Nov 2026: «ogni tanto perde… si vede magari solo un pezzo del volto, deve
/// intuire che il volto è fuori dalla visuale»; 10 Nov 2026: «spesso mi perde», «se vedi che esce dalla vista a destra
/// vuol dire che sto andando verso destra, quindi predici il movimento»). Boxes are Vision's, 0…1 with the origin at
/// the bottom left; targets are 0…1 with y from the top, the range the relay and the robot accept. An answer at an
/// edge turns the head toward it: about 23° sideways (17° when the image is a window around the face), 18° up.
/// - A face cut by the frame edge counts by its height too (half a face is narrow), and its centre is put back where
///   the whole face would be, using the width of the whole face seen in the last seconds.
/// - No face but a person (from behind or the side): aim at the top of the body, where the head is.
/// - A face that was there and is gone went on the way it was going. The side is the edge it was last seen near, or,
///   in a small image (80×60: the robot cuts it around where the face was, so a face off its centre is a face that
///   moved), the side it leaned to. One step that way within 1.2 s of the last sighting and a second one 0.8 s later;
///   then, still nobody, the same steps undone: the head goes back where it last saw the face. Upward too (someone
///   standing up); never downward, the head cannot look down.
/// - Lost with no side to guess (the middle of the image), or too long ago for a step, and nobody for 3 s: one look
///   around, a step to one side, back, a step to the other, back.
/// - Then the head stays until someone is seen again.
/// - A step is used only when its answer can leave (`free`: the app sends one answer at a time; until 10 Nov 2026 the
///   steps worked out while an answer was travelling were lost), and every step after the first waits for an image
///   taken after the head moved: the second frame after the one that carried the step before.
/// - Nobody yet since following started: the head looks up, twice at most, 1 s apart. Someone sitting close is above
///   the robot: with the head straight its camera sees the chest (robot frame, 9 Nov 2026).
/// Tried in a simulation of the measured loop with the robot's own rules (10 Nov 2026, 18 scenes, sideways only): the
/// person was out of the image for 27 s in all instead of 70. The rule that guessed the way from the face's speed
/// between two sightings is gone: a place in a window and one in a whole image do not compare.
struct RobotFaceFollowMemory {
    struct Box: Equatable { var x, y, width, height: Double }
    static let edge = 0.03, minimumSize = 0.06, lostWindow = 1.2, searchGap = 0.8, maxSearches = 2, sizeMemory = 4.0, startWait = 0.6, startGap = 1.0
    /// A face this far from the centre of a small image was moving that way; seconds between the answers of a return or
    /// of a look around (the head has to get there and a new image to come); seconds with nobody before a look around.
    static let lean = 0.15, stepGap = 1.2, sweepWait = 3.0
    /// Width of a face over its height in a robot frame (160×120 or 80×60, both 4:3; a face is about 0.85 as wide as tall).
    static let faceAspect = 0.64
    private var last: (x: Double, y: Double, at: Double, lean: Bool)?
    private var faceWidth: (value: Double, at: Double)?
    /// This loss: the steps taken the way the face went, the answers still to give (return or look around), search over.
    private var steps: [(x: Double, y: Double)] = [], plan: [(x: Double, y: Double)]?, done = false
    private var searchedAt = -Double.infinity, searchFrame: UInt32?, firstMissing: Double?, startSearches = 0
    /// Vision may give a cut face a box that goes past the frame edge (seen on robot frames, 9 Nov 2026): that is its
    /// own guess of the whole face, so such a box is kept as long as part of it is in the frame.
    private static func valid(_ b: Box) -> Bool {
        [b.x, b.y, b.width, b.height].allSatisfy(\.isFinite) && b.width > 0 && b.height > 0 && b.width <= 1.5 && b.height <= 1.5
            && b.x < 1 && b.x + b.width > 0 && b.y < 1 && b.y + b.height > 0
    }
    private static func target(_ x: Double, _ yFromTop: Double) -> (x: Double, y: Double) {
        ((min(1, max(0, x)) * 1000).rounded() / 1000, (min(1, max(0, yFromTop)) * 1000).rounded() / 1000)
    }
    /// Someone is seen: any search is over, and the next loss starts a new one.
    private mutating func remember(_ x: Double, _ yFromTop: Double, at now: Double, lean: Bool) {
        last = (x, yFromTop, now, lean); steps = []; plan = nil; done = false; searchedAt = -.infinity; searchFrame = nil
    }
    private mutating func use(_ target: (x: Double, y: Double), at now: Double, frame: UInt32) -> (x: Double, y: Double) {
        searchedAt = now; searchFrame = frame; return target
    }
    /// A face in this frame: where to aim, or nil when it is too small to be a face worth following. `small` is true
    /// for an 80×60 image.
    mutating func seen(_ b: Box, at now: Double, small: Bool = false) -> (x: Double, y: Double)? {
        guard now.isFinite, Self.valid(b), max(b.width, b.height) >= Self.minimumSize else { return nil }
        let cutLeft = b.x <= Self.edge, cutRight = b.x + b.width >= 1 - Self.edge
        let cutBottom = b.y <= Self.edge, cutTop = b.y + b.height >= 1 - Self.edge
        if !cutLeft && !cutRight { faceWidth = (b.width, now) }
        let remembered = faceWidth.flatMap { now - $0.at <= Self.sizeMemory ? $0.value : nil }
        let wholeWidth = max(b.width, remembered ?? b.height * Self.faceAspect)
        let wholeHeight = max(b.height, (cutLeft || cutRight ? wholeWidth : b.width) / Self.faceAspect)
        var cx = b.x + b.width / 2, cy = b.y + b.height / 2
        if cutLeft && !cutRight { cx = b.x + b.width - wholeWidth / 2 } else if cutRight && !cutLeft { cx = b.x + wholeWidth / 2 }
        if cutTop && !cutBottom { cy = b.y + wholeHeight / 2 } else if cutBottom && !cutTop { cy = b.y + b.height - wholeHeight / 2 }
        remember(cx, 1 - cy, at: now, lean: small)
        return Self.target(cx, 1 - cy)
    }
    /// No face, but a person's upper body: the head is in the top quarter of the box.
    mutating func seenBody(_ b: Box, at now: Double) -> (x: Double, y: Double)? {
        guard now.isFinite, Self.valid(b), b.width >= 0.08, b.height >= 0.1 else { return nil }
        let cx = b.x + b.width / 2, top = 1 - (b.y + b.height)
        remember(cx, top + b.height * 0.2, at: now, lean: false)
        return Self.target(cx, top + b.height * 0.2)
    }
    /// Nobody in this frame: the next answer of the search, or nil (the head stays where it is). `frame` is the robot's
    /// number of this frame; `free` is false while an answer is still travelling, and then nothing is used up.
    mutating func missing(at now: Double, frame: UInt32, free: Bool = true) -> (x: Double, y: Double)? {
        guard now.isFinite else { return nil }
        guard let last else {
            let since = firstMissing ?? now; firstMissing = since
            guard free, now - since >= Self.startWait, startSearches < Self.maxSearches, now - searchedAt >= Self.startGap else { return nil }
            startSearches += 1; searchedAt = now
            return (0.5, 0)
        }
        guard free, !done else { return nil }
        // The frame right after a step was taken before the head moved (frame numbers may start again from 1).
        let fresh = searchFrame.map { frame < $0 || frame - $0 >= 2 } ?? true
        if plan == nil {
            let side: Double? = last.x < 0.15 ? 0 : last.x > 0.85 ? 1 : last.lean && abs(last.x - 0.5) >= Self.lean ? (last.x < 0.5 ? 0 : 1) : nil
            let up = last.y < 0.15 || (last.lean && last.y <= 0.5 - Self.lean)
            if side != nil || up, steps.count < Self.maxSearches {
                // The first step only right after the loss; the second once the head has moved.
                if steps.isEmpty ? now - last.at <= Self.lostWindow : (now - searchedAt >= Self.searchGap && fresh) {
                    steps.append((side ?? 0.5, up ? 0 : 0.5))
                    return use(steps[steps.count - 1], at: now, frame: frame)
                }
                if !steps.isEmpty { return nil }
            }
            if !steps.isEmpty {
                // Nobody that way: every step undone, the last one first (the opposite edge of the image).
                guard now - searchedAt >= Self.stepGap, fresh else { return nil }
                plan = steps.reversed().map { (1 - $0.x, 1 - $0.y) }
            } else {
                guard now - last.at >= Self.sweepWait else { return nil }
                let side: Double = last.x >= 0.5 ? 1 : 0
                plan = [(side, 0.5), (1 - side, 0.5), (1 - side, 0.5), (side, 0.5)]
            }
        } else if now - searchedAt < Self.stepGap || !fresh { return nil }
        guard var rest = plan, !rest.isEmpty else { done = true; return nil }
        let next = rest.removeFirst(); plan = rest; done = rest.isEmpty
        return use(next, at: now, frame: frame)
    }
}

/// Audio of the Live call, the same as the robot MOD (live-wire.js, 10 Nov 2026): 8 kHz µ-law (G.711), one byte a
/// sample, in pieces of 800 bytes, a tenth of a second. A type-3 payload is two marker bytes and then the µ-law
/// bytes, an even number of them. What has no marker (the 16 kHz PCM16 of before) is dropped, never played as noise.
/// Why: the robot's link carries 30–35 KB a second in all, and PCM16 at 16 kHz was 32 KB a second each way.
/// Microphone and speaker stay at 16 kHz on both sides: going out two samples become one through a small filter
/// (the one before, twice the first, the second: a quarter each); coming in every sample is played twice, the first
/// time halfway from the one before.
enum RobotCallAudio {
    static let piece = 800, pieceMax = 1600, marker: [UInt8] = [0xB1, 0x08]
    private static let exponent: [Int] = (0..<256).map { $0 < 2 ? 0 : $0 < 4 ? 1 : $0 < 8 ? 2 : $0 < 16 ? 3 : $0 < 32 ? 4 : $0 < 64 ? 5 : $0 < 128 ? 6 : 7 }
    private static let linear: [Int] = (0..<256).map { code in
        let u = ~code & 0xFF, t = (((u & 15) << 3) + 132) << ((u & 0x70) >> 4)
        return u & 0x80 != 0 ? 132 - t : t - 132
    }
    /// µ-law bytes carried by a type-3 payload; 0 when it is not call audio in this format.
    static func length(_ payload: Data) -> Int {
        let count = payload.count - 2
        guard count >= 2, count <= pieceMax, count % 2 == 0, payload.first == marker[0], payload.dropFirst().first == marker[1] else { return 0 }
        return count
    }
    /// Takes 16 kHz PCM16 (little-endian) as the microphone gives it, in reads of any size, and returns the payloads
    /// that are ready: the marker and 800 µ-law bytes each. A sample left alone waits for the next read.
    struct Packer {
        private var law = [UInt8](), before = 0, odd: Int?
        mutating func clear() { law = []; before = 0; odd = nil }
        mutating func add(_ pcm: Data) -> [Data] {
            let bytes = [UInt8](pcm), count = bytes.count / 2
            var ready = [Data](), i = 0
            func sample(_ at: Int) -> Int { Int(Int16(bitPattern: UInt16(bytes[at * 2]) | UInt16(bytes[at * 2 + 1]) << 8)) }
            if let first = odd, count > 0 { odd = nil; if let payload = push(first, sample(0)) { ready.append(payload) }; i = 1 }
            while i + 1 < count { if let payload = push(sample(i), sample(i + 1)) { ready.append(payload) }; i += 2 }
            if i < count { odd = sample(i) }
            return ready
        }
        private mutating func push(_ a: Int, _ b: Int) -> Data? {
            var sample = (before + a + a + b) >> 2, sign = 0; before = b
            if sample < 0 { sample = -sample; sign = 0x80 }
            if sample > 32635 { sample = 32635 }
            sample += 132
            let exponent = RobotCallAudio.exponent[sample >> 7]
            law.append(UInt8(~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 15)) & 0xFF))
            guard law.count == RobotCallAudio.piece else { return nil }
            defer { law.removeAll(keepingCapacity: true) }
            return Data(RobotCallAudio.marker + law)
        }
    }
    /// The 16 kHz samples of a payload, two for every µ-law byte; nil when it is not call audio in this format.
    /// The last sample goes on to the next piece.
    struct Player {
        private(set) var last = 0
        mutating func clear() { last = 0 }
        mutating func samples(_ payload: Data) -> [Int16]? {
            guard RobotCallAudio.length(payload) > 0 else { return nil }
            var out = [Int16](); out.reserveCapacity((payload.count - 2) * 2)
            for byte in payload.dropFirst(2) {
                let sample = RobotCallAudio.linear[Int(byte)]
                out.append(Int16((last + sample) >> 1)); out.append(Int16(sample)); last = sample
            }
            return out
        }
    }
}

struct RobotFacePose {
    var yaw: Double; var pitch: Double; var leftEye: Double; var rightEye: Double; var mouth: Double
    func valid() -> Bool { [yaw,pitch,leftEye,rightEye,mouth].allSatisfy(\.isFinite) && abs(yaw) <= 10 && abs(pitch) <= 10 && [leftEye,rightEye,mouth].allSatisfy { (0...1).contains($0) } }
}

/// Face styles shared by the app, the relay and the robot MOD (same ids everywhere).
enum RobotFaceStyle: String, CaseIterable, Identifiable {
    case portrait, white, redhead
    var id: String { rawValue }
    var title: String {
        switch self { case .portrait: return "Ritratto"; case .white: return "Robot bianco"; case .redhead: return "Lentiggini" }
    }
    /// Asset name of one expression: neutral, happy, sad, blink, talk-small, talk-open.
    func image(_ frame: String) -> String {
        switch self { case .portrait: return "Face-\(frame)"; case .white: return "Face-White-\(frame)"; case .redhead: return "Face-Red-\(frame)" }
    }
    /// Band of the 320×240 picture holding eyes and brows: blinking replaces only this band, so a
    /// blink never closes the mouth while speaking.
    var eyeBand: ClosedRange<Double> {
        switch self { case .portrait: return 104...150; case .white: return 82...146; case .redhead: return 106...144 } // red: smaller face since 9 Nov 2026
    }
    /// The white robot's happy frame has an open mouth, so it stays neutral while silent.
    var smilesWhileListening: Bool { self != .white }
    static func from(_ id: String) -> RobotFaceStyle { RobotFaceStyle(rawValue: id) ?? .portrait }
}

/// Smooths the mouth opening on every screen frame: opens quickly, closes a little slower, like a
/// real mouth, instead of jumping at every 60 ms audio piece.
struct RobotMouthSmoother {
    private(set) var value = 0.0
    private var last: Double?
    /// Moves toward `target` (0...1) for the time elapsed since the previous call.
    mutating func step(toward target: Double, at now: Double) -> Double {
        let dt = last.map { min(0.1, max(0, now - $0)) } ?? 0; last = now
        let target = min(1, max(0, target.isFinite ? target : 0))
        let speed = target > value ? 22.0 : 11.0 // per second: ~45 ms to open, ~90 ms to close
        value += (target - value) * (1 - exp(-speed * dt))
        if abs(value - target) < 0.002 { value = target }
        return value
    }
}

/// Why a Live connection ended, in plain words (10 Nov 2026). The relay closes with a short reason (robot-link.ts
/// `closeAll`) or refuses the connection with an HTTP status; iOS reports all of them as «Socket is not connected»,
/// which told the owner nothing. `session_timeout` is what the relay published before 10 Nov said for three
/// different things.
enum RobotLiveClose {
    static let again = "Tocca «Collega al robot» per ricominciare."
    static func message(reason: String?, status: Int?, error: String) -> String {
        if status == 409 { return "Un’altra app è già collegata al robot: chiudila e riprova." }
        if status == 401 { return "Token non valido: controllalo nella scheda Robot." }
        switch reason {
        case "session_expired": return "Sessione Live finita: dura al massimo 10 minuti. \(again)"
        case "session_timeout": return "Il servizio ha chiuso il collegamento: sono passati 10 minuti oppure il robot non ha risposto in tempo. \(again)"
        case "robot_silent": return "Il robot non dà segnali da 15 secondi: controlla Wi-Fi e alimentazione. \(again)"
        case "app_silent": return "L’iPhone non ha raggiunto il servizio per 15 secondi: controlla la rete. \(again)"
        case "peer_disconnected", "peer_error": return "Il robot ha chiuso il collegamento e si ricollega da solo in pochi secondi. \(again)"
        case "command_timeout", "invalid_ack": return "Il robot non ha confermato un comando in tempo: collegamento chiuso per sicurezza. \(again)"
        case "rate_limit": return "Troppi dati in un secondo: collegamento chiuso per sicurezza. \(again)"
        default: break
        }
        // Any other reason of the relay is shown as it is, but only if it looks like one (short, lowercase words).
        if let reason, (1...40).contains(reason.utf8.count), reason.utf8.allSatisfy({ $0 == 95 || (97...122).contains($0) }) { return "Il servizio ha chiuso il collegamento (\(reason)). \(again)" }
        return "Collegamento terminato: \(error)"
    }
}

@MainActor final class RobotLiveClient: ObservableObject {
    @Published private(set) var socketConnected = false
    @Published private(set) var status: RobotLiveStatus?
    @Published var message = "Collega il robot per iniziare."
    @Published private(set) var cameraFrame: RobotMediaPacket?
    @Published private(set) var pendingCount = 0
    var onAudio: ((Data) -> Void)?
    var onVideo: ((RobotMediaPacket) -> Void)?
    var onDisconnect: (() -> Void)?
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void,Never>?
    private var heartbeat: Task<Void,Never>?
    private var writer: Task<Void,Never>?
    private var revision = UUID()
    private var sequence: UInt32 = 0
    private var receivedSequence: UInt32 = 0
    private var videoAssembler = RobotVideoAssembler()
    private var queue: [Data] = []
    private var queuedBytes = 0
    private var pending: [String: (CheckedContinuation<Void,Error>, Task<Void,Never>)] = [:]
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 20
        return URLSession(configuration: configuration)
    }()
    var ready: Bool { socketConnected && status?.connected == true }
    var sessionID: UUID { revision }
    /// The relay accepts one app connection at a time. A page (Live, Test, Aspetto, Studio) always wins over the
    /// automatic face following of a conversation: opening it closes the automatic channel first and waits a moment.
    var automatic = false
    private(set) static var pageClients = 0
    /// Set by the automatic following: closes its channel and returns true if one was open.
    static var beforePageConnect: (() -> Bool)?
    private var counted = false
    func connect(token: String) {
        disconnect()
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.count >= 32 else { message = "Salva prima il token nella scheda Robot."; return }
        if !automatic { counted = true; Self.pageClients += 1 }
        let yielded = !automatic && (Self.beforePageConnect?() ?? false)
        var request = URLRequest(url: URL(string: "https://robottino-stackchan.example.workers.dev/api/robot/live")!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request), current = UUID(); revision = current
        task.maximumMessageSize = 160000; socket = task; message = "Collegamento in corso…"
        if yielded { Task { [weak self] in try? await Task.sleep(nanoseconds: 700_000_000); if self?.revision == current { task.resume() } } } else { task.resume() }
        receiver = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let event = try await task.receive()
                    guard let self, self.revision == current else { return }
                    try self.receive(event)
                }
            } catch {
                guard let self, self.revision == current else { return }
                // Read before disconnect(): the reason the relay gave when it closed, or the status of a refused connection.
                let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) }, status = (task.response as? HTTPURLResponse)?.statusCode
                self.disconnect(); self.message = RobotLiveClose.message(reason: reason, status: status, error: error.localizedDescription)
            }
        }
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 5_000_000_000); guard let self, self.revision == current else { return }; try await task.send(.string("{\"type\":\"ping\"}")) }
                catch { return }
            }
        }
    }
    func disconnect() {
        if counted { counted = false; Self.pageClients -= 1 }
        revision = UUID(); receiver?.cancel(); heartbeat?.cancel(); writer?.cancel(); receiver = nil; heartbeat = nil; writer = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        socketConnected = false; status = nil; cameraFrame = nil; videoAssembler.reset(); receivedSequence = 0; sequence = 0; queue = []; queuedBytes = 0
        let old = pending; pending = [:]; pendingCount = 0
        for (_, (continuation, timer)) in old { timer.cancel(); continuation.resume(throwing: RobotLiveError.offline) }
        onDisconnect?()
    }
    private func receive(_ event: URLSessionWebSocketTask.Message) throws {
        switch event {
        case .data(let data):
            let packet = try RobotMediaPacket.decode(data)
            guard packet.sequence > receivedSequence, packet.kind != 2, packet.kind != 5, packet.kind != 7 else { throw RobotLiveError.invalid }
            receivedSequence = packet.sequence
            if packet.kind == 4 || packet.kind == 6 {
                if let frame = try videoAssembler.append(packet) { cameraFrame = frame; onVideo?(frame) }
            } else if packet.kind == 1 { cameraFrame = packet; onVideo?(packet) } else if packet.kind == 3 { onAudio?(packet.payload) }
        case .string(let text):
            guard text.utf8.count <= 8192, let data = text.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String:Any], let type = object["type"] as? String else { throw RobotLiveError.invalid }
            if type == "connected" { socketConnected = true; message = "Canale aperto; attendo il robot." }
            if type == "status" {
                status = try JSONDecoder().decode(RobotLiveStatus.self, from: data)
                message = status?.connected == true ? (status?.simulated == true ? "Robot virtuale collegato." : "Robot collegato.") : "Robot offline. Il canale cloud è disponibile."
            }
            if type == "ack", let id = object["id"] as? String, let ok = object["ok"] as? Bool, let (continuation,timer) = pending.removeValue(forKey: id) {
                timer.cancel(); pendingCount = pending.count
                if ok { continuation.resume() } else { continuation.resume(throwing: RobotLiveError.rejected(object["error"] as? String ?? "errore dispositivo")) }
            }
        @unknown default: throw RobotLiveError.invalid
        }
    }
    func command(_ action: String, values: [String:Any] = [:]) async throws {
        guard ready, let socket else { throw RobotLiveError.offline }
        guard pending.count < 4 else { throw RobotLiveError.busy }
        let id = UUID().uuidString, current = revision
        var object = values; object["type"] = "command"; object["id"] = id; object["action"] = action
        let encoded = try JSONSerialization.data(withJSONObject: object)
        guard encoded.count <= 4096, let text = String(data: encoded, encoding: .utf8) else { throw RobotLiveError.invalid }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let timer = Task { [weak self] in
                // Longer than the server's 1.5 s ACK window: the server reports its own timeout first.
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
                guard let self, self.revision == current, let (waiting,_) = self.pending.removeValue(forKey: id) else { return }
                self.pendingCount = self.pending.count; waiting.resume(throwing: RobotLiveError.timeout); self.disconnect(); self.message = "Comando non confermato. Collegamento chiuso."
            }
            pending[id] = (continuation,timer); pendingCount = pending.count
            Task { [weak self] in
                do { guard let self, self.revision == current, self.pending[id] != nil else { return }; try await socket.send(.string(text)) }
                catch { guard let self, self.revision == current else { return }; self.disconnect() }
            }
        }
        guard revision == current, ready else { throw RobotLiveError.offline }
    }
    func media(kind: UInt8, width: Int = 0, height: Int = 0, payload: Data) {
        guard ready, sequence < UInt32.max else { return }
        sequence += 1
        guard let data = try? RobotMediaPacket(kind: kind, sequence: sequence, width: width, height: height, payload: payload).encoded(), queuedBytes + data.count <= 200000 else { return }
        queue.append(data); queuedBytes += data.count
        guard writer == nil, let socket else { return }
        let current = revision
        writer = Task { [weak self] in
            guard let self else { return }
            while self.revision == current && !self.queue.isEmpty && !Task.isCancelled {
                let next = self.queue.removeFirst(); self.queuedBytes -= next.count
                do { try await socket.send(.data(next)) } catch { if self.revision == current { self.disconnect() }; return }
            }
            if self.revision == current { self.writer = nil }
        }
    }
}

// MARK: - Conversation with the AI provider (iPhone microphone and speaker)

enum RobotVoiceProvider: String {
    case openai, elevenlabs
    var name: String { self == .openai ? "OpenAI Live 1" : "ElevenLabs V1 Max" }
    /// Default PCM16 mono rate before the provider declares its own.
    var defaultRate: Int { self == .openai ? 24000 : 16000 }
}

enum RobotVoiceAction: Equatable {
    case ready(inputRate: Int, outputRate: Int)
    case audio(Data)
    case interrupt
    case userText(String, final: Bool)
    case assistantText(String)
    case pong(String)
    case memory(String, confirmation: String?)
    case failure(String)
}

enum RobotVoiceProtocol {
    static func parse(_ text: String, provider: RobotVoiceProvider) -> [RobotVoiceAction] {
        guard let data = text.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let type = object["type"] as? String else { return [.failure("Risposta del servizio vocale non valida.")] }
        switch type {
        case "session.started": return [.ready(inputRate: 24000, outputRate: 24000)]
        case "conversation_initiation_metadata":
            let meta = object["conversation_initiation_metadata_event"] as? [String: Any]
            guard let input = rate(meta?["user_input_audio_format"] as? String ?? "pcm_16000"), let output = rate(meta?["agent_output_audio_format"] as? String ?? "pcm_16000") else { return [.failure("Formato audio del provider non supportato.")] }
            return [.ready(inputRate: input, outputRate: output)]
        case "session.output_audio.delta": return audio(object["delta"])
        case "audio": return audio((object["audio_event"] as? [String: Any])?["audio_base_64"])
        case "session.input_audio.speech_started", "interruption": return [.interrupt]
        case "session.input_transcript.delta": return (object["delta"] as? String).map { [.userText($0, final: false)] } ?? []
        case "user_transcript": return ((object["user_transcription_event"] as? [String: Any])?["user_transcript"] as? String).map { [.userText($0, final: true)] } ?? []
        case "session.output_transcript.delta": return (object["delta"] as? String).map { [.assistantText($0)] } ?? []
        case "agent_response": return ((object["agent_response_event"] as? [String: Any])?["agent_response"] as? String).map { [.assistantText($0)] } ?? []
        case "ping":
            let id = (object["ping_event"] as? [String: Any])?["event_id"]
            return [.pong(id.map { "\($0)" } ?? "0")]
        case "memory.result": return object["error"] as? String == "invalid_command" ? [] : [memory(object)]
        case "error", "session.error": return [.failure("Il servizio vocale ha segnalato un errore.")]
        default: return []
        }
    }
    static func rate(_ format: String) -> Int? {
        guard format.hasPrefix("pcm_"), let value = Int(format.dropFirst(4)), (8000...48000).contains(value) else { return nil }
        return value
    }
    private static func audio(_ value: Any?) -> [RobotVoiceAction] {
        guard let text = value as? String, let data = Data(base64Encoded: text), !data.isEmpty, data.count % 2 == 0 else { return [] }
        return [.audio(data)]
    }
    private static func memory(_ object: [String: Any]) -> RobotVoiceAction {
        if let error = object["error"] as? String { return .memory(error == "memory_busy" ? "Attendi: sto ancora gestendo il ricordo precedente." : "Comando sui ricordi non riuscito.", confirmation: nil) }
        let result = object["result"] as? [String: Any] ?? [:]
        if let token = result["confirmation"] as? String { return .memory("Vuoi davvero cancellare tutti i ricordi? Conferma sullo schermo.", confirmation: token) }
        switch result["error"] as? String {
        case "ambiguous": return .memory("Più ricordi corrispondono: ripeti la frase in modo più preciso.", confirmation: nil)
        case "not_found": return .memory("Non ho trovato quel ricordo.", confirmation: nil)
        case "secret_not_allowed": return .memory("Non salvo password, chiavi o codici.", confirmation: nil)
        case "memory_limit": return .memory("Hai raggiunto il limite di 100 ricordi.", confirmation: nil)
        case .some: return .memory("Comando sui ricordi non riuscito.", confirmation: nil)
        case nil: break
        }
        if let forgotten = result["forgotten"] as? [String: Any], let text = forgotten["text"] as? String { return .memory("Confermato: ho dimenticato «\(text)».", confirmation: nil) }
        if let memory = result["memory"] as? [String: Any], let text = memory["text"] as? String { return .memory("Confermato: ricordo salvato «\(text)».", confirmation: nil) }
        if let list = result["memories"] as? [Any] { return .memory(list.isEmpty ? "Nessun ricordo trovato." : "Ricordi trovati: \(list.count).", confirmation: nil) }
        if result["ok"] as? Bool == true { return .memory("Confermato: tutti i ricordi sono stati cancellati.", confirmation: nil) }
        return .memory("Comando sui ricordi completato.", confirmation: nil)
    }
    /// Loose filter: anything about memories goes to the server, which parses it strictly.
    static func isMemoryPhrase(_ text: String) -> Bool {
        let value = text.lowercased()
        return ["ricord", "memorizz", "tieni a mente", "dimentic", "scord", "segnat", "cosa sai di me"].contains { value.contains($0) }
    }
    static func audioMessage(_ pcm: Data, provider: RobotVoiceProvider) -> String {
        let encoded = pcm.base64EncodedString()
        return provider == .openai ? "{\"type\":\"session.input_audio.append\",\"audio\":\"\(encoded)\"}" : "{\"user_audio_chunk\":\"\(encoded)\"}"
    }
    static func pongMessage(_ id: String) -> String {
        "{\"type\":\"pong\",\"event_id\":\(Int(id) ?? 0)}"
    }
    static func memoryMessage(text: String) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: ["type": "memory.command", "text": text]) else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func clearMessage(confirmation: String) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: ["type": "memory.command", "command": ["action": "clear", "confirmation": confirmation]]) else { return nil }
        return String(data: data, encoding: .utf8)
    }
    /// Same thresholds as the firmware's pcmMouthLevel, so app and robot animate alike.
    /// How open the mouth is, 0...1, following the voice continuously (for smooth drawing on the
    /// phone; the robot keeps the three steps of `mouthLevel`).
    static func mouthOpenness(_ pcm: Data) -> Double {
        let count = pcm.count / 2
        guard count > 0 else { return 0 }
        var energy = 0.0
        pcm.withUnsafeBytes { raw in
            for i in 0..<count { let sample = Double(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))); energy += sample * sample }
        }
        return min(1, max(0, ((energy / Double(count)).squareRoot() - 500) / 2100))
    }
    static func mouthLevel(_ pcm: Data) -> Double {
        let count = pcm.count / 2
        guard count > 0 else { return 0 }
        var energy = 0.0
        pcm.withUnsafeBytes { raw in
            for i in 0..<count { let sample = Double(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))); energy += sample * sample }
        }
        let rms = (energy / Double(count)).squareRoot()
        return rms > 1600 ? 0.8 : rms > 900 ? 0.35 : 0
    }
}

struct RobotVoiceLine: Identifiable, Equatable { let id = UUID(); let user: Bool; var text: String }

/// Keeps the last turns readable: deltas join the current line, a new speaker starts a new one.
struct RobotVoiceTranscript {
    private(set) var lines: [RobotVoiceLine] = []
    private(set) var pendingUser = ""
    /// Returns a finished user sentence when the turn ends.
    mutating func apply(_ action: RobotVoiceAction) -> String? {
        switch action {
        case .userText(let text, let final):
            append(text, user: true, join: !final)
            if final { pendingUser = ""; return text }
            pendingUser += text; return nil
        case .assistantText(let text):
            let finished = pendingUser.isEmpty ? nil : pendingUser
            pendingUser = ""
            append(text, user: false, join: true); return finished
        default: return nil
        }
    }
    private mutating func append(_ text: String, user: Bool, join: Bool) {
        if join, let last = lines.last, last.user == user { lines[lines.count - 1].text = String((last.text + text).suffix(600)) }
        else { lines.append(RobotVoiceLine(user: user, text: String(text.suffix(600)))) }
        if lines.count > 12 { lines.removeFirst(lines.count - 12) }
    }
}

// MARK: - Reply mood and spoken timers (same rules as the robot's voice-wire.js)

struct RobotReplyMood: Equatable {
    let expression: String
    let gesture: String?
    /// The smiling face only when Robottino actually laughs, not for any cheerful word.
    static let laughter = #"a?h(?:ah)+|ah ?ah|eh(?:eh)+|ih(?:ih)+|hi(?:hi)+|che ridere|mi fai ridere|rido(?![a-zàèéìíòóùú])|risat"#
    /// Face and one head gesture from the words of Robottino's reply: no extra AI calls.
    static func from(_ text: String) -> RobotReplyMood? {
        let value = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        func has(_ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
        let gesture = has(#"^(?:sì|si|certo|certamente|esatto|giusto|va bene|ok|okay|perfetto|d'accordo|d’accordo|volentieri)(?![a-zàèéìíòóùú])"#) ? "nod" : has(#"^(?:no|nah|non credo|assolutamente no)(?![a-zàèéìíòóùú])"#) ? "shake" : has(#"\?\s*$"#) ? "tilt" : nil
        // The face follows only the sentence being spoken: "mi dispiace" makes it sad until the next
        // sentence starts, not for the rest of the reply. The gesture keeps looking at the start.
        let sentence = value.range(of: #"[.!?…]\s+(?=\S)"#, options: [.regularExpression, .backwards]).map { String(value[$0.upperBound...]) } ?? value
        func said(_ pattern: String) -> Bool { sentence.range(of: pattern, options: .regularExpression) != nil }
        let expression = said(#"mi dispiace|purtroppo|peccato|triste|scusami|scusa(?![a-zàèéìíòóùú])|non posso|non riesco"#) ? "sad" : said(Self.laughter) ? "happy" : "neutral"
        return RobotReplyMood(expression: expression, gesture: gesture)
    }
}

enum RobotTimerCommand: Equatable {
    case set(seconds: Int, label: String), pomodoro, cancel, status, invalid
    private static let numbers: [String: Double] = ["un": 1, "uno": 1, "una": 1, "due": 2, "tre": 3, "quattro": 4, "cinque": 5, "sei": 6, "sette": 7, "otto": 8, "nove": 9, "dieci": 10, "undici": 11, "dodici": 12, "tredici": 13, "quattordici": 14, "quindici": 15, "sedici": 16, "diciassette": 17, "diciotto": 18, "diciannove": 19, "venti": 20, "venticinque": 25, "trenta": 30, "quaranta": 40, "quarantacinque": 45, "cinquanta": 50, "sessanta": 60, "novanta": 90]
    /// "avvisami tra 10 minuti", "timer di 5 minuti", "ricordami tra mezz'ora di …", "pomodoro", "annulla il timer", "quanto manca?".
    static func parse(_ text: String) -> RobotTimerCommand? {
        var value = text.lowercased().replacingOccurrences(of: "’", with: "'").replacingOccurrences(of: "`", with: "'")
        value = value.replacingOccurrences(of: #"^(?:ehi|ciao|ok|senti)?\s*robottino[\s,:!]*"#, with: "", options: .regularExpression)
        value = value.replacingOccurrences(of: #"[.!?]+$"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        func has(_ pattern: String, in text: String? = nil) -> Bool { (text ?? value).range(of: pattern, options: .regularExpression) != nil }
        if has(#"\b(?:annulla|ferma|cancella|togli|elimina|stop)\b.*\b(?:timer|pomodoro|promemoria|sveglia|avvis)"#) { return .cancel }
        if has(#"\bquanto manca\b"#), !has(#"\b(?:a|al|alla|per)\s+(?:natale|capodanno)\b"#) { return .status }
        if has(#"\b(?:avvia|fai|facciamo|inizia|parti con|metti)\b.*\bpomodoro\b|^pomodoro$|\bmetodo pomodoro\b"#) { return .pomodoro }
        guard has(#"\b(?:timer|avvisami|ricordami|svegliami|sveglia|chiamami|dimmi quando|fammi sapere)\b"#) else { return nil }
        var seconds = 0.0, found = false
        if has(#"\bmezz'?\s?ora\b"#) { seconds += 1800; found = true }
        if has(#"\bun quarto d'?\s?ora\b"#) { seconds += 900; found = true }
        if has(#"\bun'?\s?ora e mezza\b"#) { seconds += 1800; found = true }
        let units = try! NSRegularExpression(pattern: #"(\d+(?:[.,]\d+)?|[a-z]+)\s*(secondi|secondo|minuti|minuto|ore|ora)\b"#)
        for match in units.matches(in: value, range: NSRange(value.startIndex..., in: value)) {
            guard let rawRange = Range(match.range(at: 1), in: value), let unitRange = Range(match.range(at: 2), in: value) else { continue }
            let raw = String(value[rawRange]), unit = String(value[unitRange])
            guard let amount = raw.first?.isNumber == true ? Double(raw.replacingOccurrences(of: ",", with: ".")) : numbers[raw] else { continue }
            found = true; seconds += amount * (unit.hasPrefix("second") ? 1 : unit.hasPrefix("minut") ? 60 : 3600)
        }
        let withoutHalf = value.replacingOccurrences(of: #"\bun'?\s?ora e mezza\b"#, with: "", options: .regularExpression)
        if has(#"\bun'?\s?ora\b"#), !has(#"\d+\s*or[ea]\b"#), !has(#"\b(?:mezz'?\s?ora|quarto d'?\s?ora)\b"#, in: withoutHalf) { seconds += 3600; found = true }
        guard found else { return nil }
        let total = Int(seconds.rounded())
        guard (10...6 * 3600).contains(total) else { return .invalid }
        let rest = value.replacingOccurrences(of: #"\b(?:tra|fra|in|di|per)\s+(?:\d+(?:[.,]\d+)?|[a-z']+)\s*(?:secondi|secondo|minuti|minuto|ore|ora)\b"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\b(?:tra|fra)\s+(?:mezz'?\s?ora|un quarto d'?\s?ora|un'?\s?ora(?: e mezza)?)\b"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        var label = ""
        if let range = rest.range(of: #"\b(?:di|per|che)\s+(?!\d).{3,60}$"#, options: .regularExpression) {
            label = String(rest[range]).replacingOccurrences(of: #"^(?:di|per|che)\s+"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        }
        if ["timer", "minuti", "secondi"].contains(label) { label = "" }
        return .set(seconds: total, label: label)
    }
    static func duration(_ seconds: Int) -> String {
        let h = seconds / 3600, m = seconds % 3600 / 60, s = seconds % 60
        var parts: [String] = []
        if h > 0 { parts.append(h == 1 ? "1 ora" : "\(h) ore") }
        if m > 0 { parts.append(m == 1 ? "1 minuto" : "\(m) minuti") }
        if s > 0, h == 0 { parts.append(s == 1 ? "1 secondo" : "\(s) secondi") }
        return parts.isEmpty ? "0 secondi" : parts.joined(separator: " e ")
    }
}

// MARK: - Wi-Fi to the robot over the Stack-chan settings Bluetooth service

/// Upstream Stack-chan host: Settings opens a 5-minute write window on a Nordic UART
/// service named "STK". JSON is reassembled from writes of at most 64 bytes within 3 s.
/// The channel is not encrypted at the application level (accepted by the owner).
enum RobotWiFiBluetooth {
    static let service = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
    static let rx = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
    static let tx = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"
    static let chunkBytes = 60
    static func payload(ssid: String, password: String) -> Data? {
        try? JSONSerialization.data(withJSONObject: ["_batch": ["wifi.ssid": ssid, "wifi.password": password]], options: [.sortedKeys])
    }
    /// Splits on UTF-8 character boundaries: the robot decodes every write separately.
    static func chunks(_ data: Data, size: Int = chunkBytes) -> [Data] {
        let bytes = [UInt8](data); var result: [Data] = [], start = 0
        while start < bytes.count {
            var end = min(start + size, bytes.count)
            while end < bytes.count, end > start, bytes[end] & 0xC0 == 0x80 { end -= 1 }
            result.append(Data(bytes[start..<end])); start = end
        }
        return result
    }
    /// Notifications are {"prop": "wifi.ssid", "value": …}; returns the pair when present.
    static func notification(_ data: Data) -> (prop: String, value: String)? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let prop = object["prop"] as? String, prop.hasPrefix("wifi.") else { return nil }
        return (prop, object["value"].map { "\($0)" } ?? "")
    }
}

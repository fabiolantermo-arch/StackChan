import Foundation
import SwiftUI

enum RobotLiveError: LocalizedError {
    case offline, invalid, rejected(String), timeout, busy, simulatorCamera
    var errorDescription: String? {
        switch self {
        case .offline: return "Collegamento al robot assente."
        case .invalid: return "Dati del robot non validi. Collegamento chiuso."
        case .rejected("superseded"): return "Comando annullato dallo Stop."
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
    var roverFollow: Bool? = nil   // «Inseguimento con rover» on (15 Nov 2026)
    var gazeCall: Bool? = nil      // «Chiamata con lo sguardo» on (21 Nov 2026)
    var forceFollow: Bool? = nil   // the Force follows the hand (23 Nov 2026): send where the hand is (RobotForceHand)
    var exploring: Bool? = nil     // «Esplora» going, or its conversation opening (23 Nov 2026, RobotExploreKey)
    var rover: Bool? = nil         // the rover answers

    /// The state a switch of the Robot tab reads back (RobotRemoteSwitch statusKey); nil for a key it does not know.
    func switchState(_ key: String) -> Bool? {
        switch key {
        case "motionEnabled": return motionEnabled
        case "roverFollow": return roverFollow
        case "gazeCall": return gazeCall
        default: return nil
        }
    }
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
    static let jpegMin = 100, jpegMax = 24000
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
        } else if kind == 8 {
            // One camera picture as a JPEG, whole (14 Nov 2026): what the robot sends when camera.start asked for it
            // («jpeg»). Same bounds as src/robot-wire.ts and the MOD's live-wire.js.
            guard (1...320).contains(width), (1...240).contains(height), (Self.jpegMin...Self.jpegMax).contains(payload.count), payload.prefix(2).elementsEqual([0xFF, 0xD8]) else { throw RobotLiveError.invalid }
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

/// The rover under the robot (owner, 14 Nov 2026: «Fai 1 2 5 6 7»): keys in the Live page. The directions are the
/// robot's own, as in the video from its camera (the robot faces the user, so its left is the user's right). While a
/// key is held the app sends a short move every `repeatMs`, each lasting `moveMs`: the robot stops the wheels by
/// itself `moveMs` after the last one, so a lifted finger, a closed app or a lost link all end in a stop. Lifting the
/// finger also sends a stop. Same moves and bounds as the relay (src/robot-wire.ts ROVER_MOVES, ROVER_MS) and the MOD.
/// The gripper (owner, 15 Nov 2026): gripOpen, gripHalf («chiudi poco») and gripClose («chiudi tutto») are sent once, on a tap; the time goes with them only
/// because the relay asks for one.
enum RobotRoverKeys {
    static let moveMs = 500, repeatMs = 300, stopMs = 200
    enum Move: String, CaseIterable { case forward, back, left, right, turnLeft, turnRight, stop, gripOpen, gripHalf, gripClose }
    /// Done at once by the robot, nothing to repeat while a key is held.
    static func once(_ move: Move) -> Bool { move == .stop || move == .gripOpen || move == .gripHalf || move == .gripClose }
    static func command(_ move: Move) -> [String: Any] { ["move": move.rawValue, "ms": once(move) ? stopMs : moveMs] }
    /// «Avanti» refused at the very start of a press is tried again a few times (review, 23 Nov 2026): the robot wants
    /// the head, where the distance sensor is, still and a fresh reading taken since; the first key stops the head's
    /// own moves, and about a second later the reading is there. Any other refusal, or one after a move went, blocks
    /// until the finger is lifted, as before.
    static let firstTries = 3
    static func retries(_ move: Move, refused: Int, moved: Bool) -> Bool { move == .forward && !moved && refused < firstTries }
    static func label(_ move: Move) -> String {
        switch move {
        case .forward: "Avanti"; case .back: "Indietro"; case .left: "Sinistra"; case .right: "Destra"
        case .turnLeft: "Gira a sinistra"; case .turnRight: "Gira a destra"; case .stop: "Ferma"
        case .gripOpen: "Apri pinza"; case .gripHalf: "Chiudi poco"; case .gripClose: "Chiudi tutto"
        }
    }
    static func symbol(_ move: Move) -> String {
        switch move {
        case .forward: "arrow.up"; case .back: "arrow.down"; case .left: "arrow.left"; case .right: "arrow.right"
        case .turnLeft: "arrow.counterclockwise"; case .turnRight: "arrow.clockwise"; case .stop: "stop.fill"
        case .gripOpen: "arrow.left.and.right"; case .gripHalf: "arrow.down.right.and.arrow.up.left"; case .gripClose: "arrow.right.and.line.vertical.and.arrow.left"
        }
    }
}

/// The robot's speaker volume from the Robot tab (owner, 15 Nov 2026: «distorce ancora, possiamo mettere una
/// regolazione volume sull app nella schermata robot?»). A whole level 1…10, as the relay (src/robot-wire.ts
/// VOLUME_LEVELS) and the MOD (live-wire.js VOLUME: 10 is the amplifier's 252, 6 less each level) accept it.
/// 9 is the MOD's own default.
enum RobotVolume {
    static let levels = 1...10, standard = 9
    static func command(_ level: Int) -> [String: Any]? { levels.contains(level) ? ["level": level] : nil }
}

/// Hand gestures in the robot camera's video (owner, 15 Nov 2026: «riconosci i gesti»; in the app, with Apple's hand
/// pose: thumb up and down, open hand = stop, a wave, two fingers). PREPARED, NEVER TRIED WITH THE ROBOT'S REAL VIDEO.
/// Here only the rules, on the points Vision gives (0…1 of the picture, x to the right, y UP): which fingers are
/// stretched, and what that shape is. Same names as the relay (src/robot-wire.ts HAND_GESTURES) and the MOD
/// (live-wire.js HAND_GESTURES).
enum RobotHandGesture {
    enum Kind: String, CaseIterable { case thumbsUp, thumbsDown, palm, wave, victory }
    /// What one picture shows. The wave is not a shape: it is an open hand that moves (RobotGestureWatch).
    enum Shape: Equatable { case thumbsUp, thumbsDown, palm, victory }
    struct Point: Equatable { var x: Double; var y: Double }
    struct Hand {
        var wrist: Point
        var thumbMP: Point, thumbIP: Point, thumbTip: Point
        var indexMCP: Point, indexPIP: Point, indexTip: Point
        var middleMCP: Point, middlePIP: Point, middleTip: Point
        var ringPIP: Point, ringTip: Point
        var littlePIP: Point, littleTip: Point
    }
    /// A finger is stretched when its tip is clearly farther from the wrist than its middle joint (a bent finger's
    /// tip comes back toward the palm).
    static let stretch = 1.2
    /// The thumb is out when its tip is at least this much of the palm's length away from the index finger's root.
    static let thumbOut = 0.5
    /// `aspect`: the picture's width over its height (the robot's video is 4:3), so that distances are true.
    /// The thumb points up or down when it goes at least this much up or down for each step sideways (first try on the
    /// robot, 15 Nov 2026, owner: «non riconosce il pollice all'ingiù»: a thumb down is rarely straight down, the
    /// forearm comes in from the side; it had to be more vertical than sideways, now it may lean up to about 60°).
    static let thumbLean = 0.6
    /// What the rules read in a hand: the four fingers stretched or not, the thumb out or not and where it points
    /// (1 up, −1 down, 0 sideways). nil when the hand is too small to tell.
    struct Reading: Equatable { var index: Bool, middle: Bool, ring: Bool, little: Bool, thumbOut: Bool, thumbWay: Int }
    static func reading(_ hand: Hand, aspect: Double = 4.0 / 3.0) -> Reading? {
        func far(_ a: Point, _ b: Point) -> Double { let dx = (a.x - b.x) * aspect, dy = a.y - b.y; return (dx * dx + dy * dy).squareRoot() }
        let palm = far(hand.wrist, hand.middleMCP)
        guard palm.isFinite, palm > 0.02 else { return nil } // too small to tell
        func out(_ tip: Point, _ joint: Point) -> Bool { far(tip, hand.wrist) > far(joint, hand.wrist) * stretch }
        let dx = (hand.thumbTip.x - hand.thumbMP.x) * aspect, dy = hand.thumbTip.y - hand.thumbMP.y
        return Reading(index: out(hand.indexTip, hand.indexPIP), middle: out(hand.middleTip, hand.middlePIP), ring: out(hand.ringTip, hand.ringPIP), little: out(hand.littleTip, hand.littlePIP),
                       thumbOut: far(hand.thumbTip, hand.indexMCP) >= palm * thumbOut, thumbWay: abs(dy) >= abs(dx) * thumbLean ? (dy > 0 ? 1 : -1) : 0)
    }
    static func shape(_ hand: Hand, aspect: Double = 4.0 / 3.0) -> Shape? {
        guard let r = reading(hand, aspect: aspect) else { return nil }
        if r.index, r.middle, r.ring, r.little { return .palm }
        if r.index, r.middle, !r.ring, !r.little { return .victory }
        // A fist with the thumb out: up or down by where the thumb points.
        guard !r.index, !r.middle, !r.ring, !r.little, r.thumbOut, r.thumbWay != 0 else { return nil }
        return r.thumbWay > 0 ? .thumbsUp : .thumbsDown
    }
    /// What a picture looked at upside down shows the right way up: only a thumb up counts, as a thumb down (open hand,
    /// two fingers and a thumb down upside down are not gestures anyone shows) (RobotHandDetector, 23 Nov 2026).
    static func upsideDown(_ shape: Shape?) -> Shape? { shape == .thumbsUp ? .thumbsDown : nil }
    /// A picture read upright and upside down (RobotHandDetector): a thumb up upside down is a thumb down when nothing
    /// was read upright, or when Vision is surer of the hand upside down than of the thumb up it read upright (it fits an
    /// upright hand onto a hand upside down). Otherwise what was read upright.
    static func thumbWay(upright: Shape?, uprightSure: Double, turned: Shape?, turnedSure: Double) -> Shape? {
        guard upsideDown(turned) == .thumbsDown else { return upright }
        if upright == nil { return .thumbsDown }
        return upright == .thumbsUp && turnedSure > uprightSure ? .thumbsDown : upright
    }
    /// What the app writes while it sees a hand that is no gesture yet, so that a gesture that is not recognised can be
    /// understood from the screen: which fingers it sees stretched and what the thumb does.
    static func describe(_ r: Reading) -> String {
        let fingers = [(r.index, "indice"), (r.middle, "medio"), (r.ring, "anulare"), (r.little, "mignolo")].filter(\.0).map(\.1)
        let thumb = !r.thumbOut ? "pollice chiuso" : r.thumbWay > 0 ? "pollice in su" : r.thumbWay < 0 ? "pollice in giù" : "pollice di lato"
        return "Vedo: " + (fingers.isEmpty ? "nessun dito disteso" : fingers.joined(separator: ", ")) + ", " + thumb + "."
    }
}

/// From the shapes of the pictures, one after the other, to a gesture, said once. A shape must be there in `need`
/// pictures in a row within `window`; an open hand is «stop» when it stays still for `still` seconds and «wave» when
/// it goes from side to side (two turns of at least `swing` of the picture's width). After a gesture nothing more for
/// `rest` seconds: the robot is doing it.
/// First try on the robot (15 Nov 2026, owner: «il saluto non funziona»; the app said «mano aperta: fermo»): the
/// place of the hand was its knuckles, which hardly move in a wave from the wrist, so a wave looked still. Now `x` is
/// the tip of the middle finger (RobotHandDetector); «stop» waits 0.9 s, not 0.5; a picture where the moving hand is
/// blurred and not found does not end the open hand's run; and after a «stop» the wait is short, so a wave that began
/// as a still hand is still seen.
struct RobotGestureWatch {
    static let need = 3, window = 1.0, still = 0.9, stillRange = 0.06, swing = 0.06, waveWindow = 3.0, rest = 3.0, palmRest = 1.5
    /// Third try (23 Nov 2026, owner: «non riconosce il saluto»; thumbs and two fingers were taken that minute): while the
    /// head follows a face the robot takes its pictures only with the head still, so few reach the app and a quick wave
    /// shows one turn, not two, and gaps longer than `window`. A wave is now one turn back, and the hand's path is
    /// kept across gaps of up to `trackGap`.
    static let waveTurns = 1, trackGap = 1.5
    private var samples: [(at: Double, shape: RobotHandGesture.Shape, x: Double)] = []
    /// Where the hand was in the last pictures, whatever its shape (second try, owner: «non riconosce bene il
    /// saluto»: a waving hand is blurred, and in many pictures its fingers are not read as an open hand; its place
    /// usually still is). A wave is this path going from side to side, with an open hand seen in `need` of its pictures.
    /// `thumb`: that picture showed a thumb up or down. Fourth try (23 Nov 2026, owner: «non riconosce più i gesti…
    /// continuo a vedere la mano aperta, ma non pollice su, pollice giù»): with one turn enough for a wave, a hand raised
    /// open and then closed to a thumb moved sideways a little and was taken for a wave (5 waves in a minute, no thumb),
    /// and the 3 s rest after it swallowed the thumb. A thumb seen in the wave's pictures now means no wave.
    private var track: [(at: Double, x: Double, palm: Bool, thumb: Bool)] = []
    private var quietUntil = -Double.infinity
    /// `shape`: what this picture shows (nil: no gesture); `x`: where the hand is across the picture, 0…1 (nil: no hand found).
    mutating func feed(_ shape: RobotHandGesture.Shape?, x: Double?, at now: Double) -> RobotHandGesture.Kind? {
        guard now >= quietUntil else { samples.removeAll(); track.removeAll(); return nil }
        if let last = track.last, now - last.at > Self.trackGap { track.removeAll() }
        let place = x.flatMap { $0.isFinite ? $0 : nil }
        if let place { track.append((now, place, shape == .palm, shape == .thumbsUp || shape == .thumbsDown)) }
        track.removeAll { now - $0.at > Self.waveWindow }
        if track.filter(\.palm).count >= Self.need, !track.contains(where: \.thumb), Self.turns(track.map(\.x)) >= Self.waveTurns { return said(.wave, at: now) }
        guard let shape, let place else {
            // No gesture in this picture: the count starts again, except for an open hand (it may only be blurred;
            // its run ends by itself after `window` without one).
            if samples.last?.shape != .palm { samples.removeAll() }
            return nil
        }
        if let last = samples.last, last.shape != shape || now - last.at > Self.window { samples.removeAll() }
        samples.append((now, shape, place)); samples.removeAll { now - $0.at > Self.waveWindow }
        guard samples.count >= Self.need, let first = samples.first else { return nil }
        switch shape {
        case .thumbsUp: return said(.thumbsUp, at: now)
        case .thumbsDown: return said(.thumbsDown, at: now)
        case .victory: return said(.victory, at: now)
        case .palm:
            let recent = samples.filter { now - $0.at <= Self.still }.map(\.x)
            guard now - first.at >= Self.still, recent.count >= Self.need, (recent.max() ?? 0) - (recent.min() ?? 0) <= Self.stillRange else { return nil }
            return said(.palm, at: now)
        }
    }
    private mutating func said(_ kind: RobotHandGesture.Kind, at now: Double) -> RobotHandGesture.Kind {
        samples.removeAll(); track.removeAll(); quietUntil = now + (kind == .palm ? Self.palmRest : Self.rest)
        return kind
    }
    /// How many times the hand turned back, counting only swings of at least `swing`.
    static func turns(_ xs: [Double]) -> Int {
        guard var edge = xs.first else { return 0 }
        var way = 0.0, count = 0
        for x in xs.dropFirst() {
            if way == 0 { if abs(x - edge) >= swing { way = x > edge ? 1 : -1; edge = x } }
            else if (x - edge) * way > 0 { edge = x }
            else if abs(x - edge) >= swing { way = -way; edge = x; count += 1 }
        }
        return count
    }
    static func label(_ kind: RobotHandGesture.Kind) -> String {
        switch kind {
        case .thumbsUp: "pollice su"; case .thumbsDown: "pollice giù"; case .palm: "mano aperta: fermo"
        case .wave: "saluto"; case .victory: "due dita: ballo"
        }
    }
}

/// What else the app reads in the robot's video (owner, 15 Nov 2026: «implementa: riconoscere chi sei, capire
/// l'espressione, riconoscere oggetti al volo»), all on the iPhone with Apple's Vision. PREPARED, NEVER TRIED WITH
/// THE ROBOT'S REAL VIDEO; every threshold here is a first guess, shown on the screen so that it can be set.
///  - A smile, from the mouth's outline: wider and with its corners higher than a mouth at rest.
///  - Who it is: Apple gives no face recognition, so this is only «the picture of this face looks like the ones saved
///    with "Questo sono io"» (an image likeness, VNGenerateImageFeaturePrintRequest): good for telling the owner from
///    a stranger in the same room and light, not a proof of who someone is. Nothing leaves the iPhone but the name.
///  - A thing shown to the camera, from Apple's own classifier (VNClassifyImageRequest): only the things in `objects`,
///    said in Italian. Things that always stand on a desk (screen, keyboard, lamp, plant) are left out on purpose.
/// Same kinds as the relay (src/robot-wire.ts SIGHT_KINDS) and the MOD (live-wire.js SIGHT_KINDS).
enum RobotSight {
    enum Kind: String, CaseIterable { case person, stranger, smile, serious, object }
    /// The mouth's outline in the face's own box (0…1, y UP): its two corners, its highest and its lowest point.
    struct Mouth { var left: RobotHandGesture.Point, right: RobotHandGesture.Point, top: Double, bottom: Double }
    /// A smile is `smileOn` and more; once smiling, it ends under `smileOff`. First try on the robot (15 Nov 2026,
    /// owner: «ogni tanto ride anche se io non sorrido»): 0.50 and 0.44 were too easy; now higher, held for more
    /// pictures (RobotSightWatch.need) and answered less often. Still guesses: the numbers in «Vedo: …» will tell.
    static let smileOn = 0.56, smileOff = 0.48
    /// How wide the mouth is in the face, plus how much its corners stand above its middle (in mouth widths).
    static func smileScore(_ m: Mouth) -> Double? {
        let width = m.right.x - m.left.x
        guard width.isFinite, width > 0.05, m.top >= m.bottom else { return nil }
        let lift = ((m.left.y + m.right.y) / 2 - (m.top + m.bottom) / 2) / width
        return width + lift
    }
    /// The saved pictures of the owner's face are at `distances` from this one: the owner when `need` of them are
    /// nearer than `threshold`.
    static let likeness = 0.55, likenessNeed = 2, enrolPictures = 5
    static func isOwner(distances: [Double], threshold: Double = likeness, need: Int = likenessNeed) -> Bool {
        distances.filter { $0.isFinite && $0 <= threshold }.count >= min(need, max(1, distances.count))  && !distances.isEmpty
    }
    /// The name as it goes to the robot: letters, spaces and apostrophes, 20 at most (the relay and the MOD take 24).
    static func name(_ raw: String) -> String? {
        let cleaned = String(raw.trimmingCharacters(in: .whitespacesAndNewlines).filter { $0.isLetter || $0 == " " || $0 == "'" }.prefix(20)).trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty ? nil : cleaned
    }
    /// Apple's label → how Robottino says it («Vedo una tazza.»).
    static let objects: [String: String] = [
        "apple": "una mela", "banana": "una banana", "oranges": "un'arancia", "lemon": "un limone", "pineapple": "un ananas", "carrot": "una carota",
        "bread": "il pane", "egg": "un uovo", "cheese": "il formaggio", "chocolate": "il cioccolato", "candy": "una caramella", "cake": "una torta", "pizza": "una pizza",
        "coffee": "un caffè", "cup": "una tazza", "mug": "una tazza", "drinking_glass": "un bicchiere", "bottle": "una bottiglia", "wine_bottle": "una bottiglia di vino",
        "bowl": "una ciotola", "plate": "un piatto", "fork": "una forchetta", "knife": "un coltello", "spoon": "un cucchiaio", "teapot": "una teiera",
        "book": "un libro", "magazine": "una rivista", "newspaper": "un giornale", "pen": "una penna", "scissors": "le forbici",
        "phone": "un telefono", "headphones": "le cuffie", "camera": "una macchina fotografica", "gamepad": "un gamepad", "microphone": "un microfono",
        "eyeglasses": "gli occhiali", "sunglasses": "gli occhiali da sole", "watch": "un orologio", "wallet": "un portafoglio", "coin": "una moneta", "money": "dei soldi",
        "credit_card": "una carta", "play_card": "una carta da gioco", "backpack": "uno zaino", "bag": "una borsa", "umbrella": "un ombrello", "hat": "un cappello",
        "shoes": "una scarpa", "scarf": "una sciarpa", "ball": "una palla", "toy": "un giocattolo", "balloon": "un palloncino", "flower": "un fiore",
        "hammer": "un martello", "screwdriver": "un cacciavite", "guitar": "una chitarra", "cat": "un gatto", "dog": "un cane", "cardboard_box": "una scatola", "hourglass": "una clessidra"
    ]
    /// The surest of Apple's labels that Robottino knows, when it is at least `minimum` sure.
    static let objectSure = 0.5
    static func object(_ results: [(label: String, confidence: Double)], minimum: Double = objectSure) -> String? {
        results.filter { $0.confidence >= minimum && objects[$0.label] != nil }.max { $0.confidence < $1.confidence }.flatMap { objects[$0.label] }
    }
}

/// From what each picture shows to something worth telling the robot, said once and not again for a while.
struct RobotSightWatch {
    static let need = 5, window = 2.0, smileRest = 20.0, seriousAfter = 20.0, seriousRest = 60.0
    static let personNeed = 2, strangerNeed = 5, strangerOver = 4.0, personRest = 60.0, awayResets = 30.0
    static let objectNeed = 2, objectWindow = 3.0, objectRest = 120.0
    private var smiling = false, smiles: [Double] = [], smileQuiet = -Double.infinity, seriousFrom: Double?, seriousQuiet = -Double.infinity
    private var matches: [(at: Double, owner: Bool)] = [], personQuiet = -Double.infinity, faceAt: Double?
    private var lastObject: (label: String, at: Double, count: Int)?, objectSaid: [String: Double] = [:]
    /// `score`: the smile of the face in this picture (nil: no face). A smile held for `need` pictures; or a face that
    /// has not smiled once in `seriousAfter` seconds.
    mutating func face(score: Double?, at now: Double) -> RobotSight.Kind? {
        guard let score else { smiles.removeAll(); smiling = false; seriousFrom = nil; return nil }
        if smiling ? score < RobotSight.smileOff : score < RobotSight.smileOn { smiling = false; smiles.removeAll() } else { smiling = true; smiles.append(now); smiles.removeAll { now - $0 > Self.window } }
        if smiling {
            seriousFrom = nil
            guard smiles.count >= Self.need, now >= smileQuiet else { return nil }
            smileQuiet = now + Self.smileRest; smiles.removeAll(); return .smile
        }
        if seriousFrom == nil { seriousFrom = now }
        guard let from = seriousFrom, now - from >= Self.seriousAfter, now >= seriousQuiet else { return nil }
        seriousQuiet = now + Self.seriousRest; seriousFrom = now; return .serious
    }
    /// `owner`: this picture's face looks like the saved ones (nil: no face, or nothing saved). The owner after
    /// `personNeed` pictures in a row; a stranger after `strangerNeed` in a row over `strangerOver` seconds. Greeted
    /// once; again only after the face has been away for `awayResets` seconds, and never more often than `personRest`.
    mutating func person(owner: Bool?, at now: Double) -> RobotSight.Kind? {
        guard let owner else { if let seen = faceAt, now - seen > Self.awayResets { matches.removeAll(); faceAt = nil; greeted = false }; return nil }
        faceAt = now
        if let last = matches.last, last.owner != owner { matches.removeAll() }
        matches.append((now, owner))
        guard !greeted, now >= personQuiet, let first = matches.first else { return nil }
        if owner, matches.count >= Self.personNeed { greeted = true; personQuiet = now + Self.personRest; return .person }
        if !owner, matches.count >= Self.strangerNeed, now - first.at >= Self.strangerOver { greeted = true; personQuiet = now + Self.personRest; return .stranger }
        return nil
    }
    private var greeted = false
    /// `label`: the thing this picture shows, in Robottino's words (nil: nothing it knows). The same thing in
    /// `objectNeed` pictures running; said once, and not again for `objectRest` seconds.
    mutating func object(label: String?, at now: Double) -> String? {
        guard let label else { lastObject = nil; return nil }
        if let last = lastObject, last.label == label, now - last.at <= Self.objectWindow { lastObject = (label, now, last.count + 1) } else { lastObject = (label, now, 1) }
        guard let seen = lastObject, seen.count >= Self.objectNeed, now >= (objectSaid[label] ?? -Double.infinity) else { return nil }
        objectSaid[label] = now + Self.objectRest; lastObject = nil; return label
    }
}

/// The iPhone helps the robot follow a face (owner, 15 Nov 2026: «possiamo migliorare l'inseguimento con iPhone?»).
/// The robot follows by itself with its own small detector, which often loses a face seen from below, with glasses or
/// against the light. The app, which gets the frames of that following as video, finds the face with Apple's detector
/// and answers where it is in that frame (the `track` command, as «Segui il mio viso»); the robot takes the answer
/// only while its own detector is blind (MOD live-device.js SELF_HELP_AFTER_MS). PREPARED, NEVER TRIED ON THE ROBOT.
/// The Force following the hand (owner, 23 Nov 2026: «implementa movimenti con la forza avanti e indietro, destra e
/// sinistra»): while the robot says it follows the hand (status forceFollow), the app tells it where it sees the hand
/// across the robot camera's picture (command hand, x 0…1 from the left, as in the picture: the robot's own left is
/// x < 0.5); at most one every `every` seconds and only with nothing else waiting, so the link stays free.
enum RobotForceHand {
    static let every = 0.15
    static func shouldSend(following: Bool, ready: Bool, pending: Int, x: Double?, since: Double) -> Bool {
        guard following, ready, pending == 0, let x, x.isFinite, (0...1).contains(x) else { return false }
        return since >= every
    }
}

/// «Esplora» of the Studio (owner, 23 Nov 2026: «nella scheda studio dell'app, sopra la sezione rover, metti un tastino
/// esplora»; then «permetti la prova dell'esplorazione anche senza il rover. Muovo io il robot, inquadro degli oggetti»).
/// One key: it starts or stops, as the robot says it is going (status exploring). The robot opens a conversation if
/// none is going, and says what it sees; without the rover it stands still and is carried by hand.
enum RobotExploreKey {
    static func allowsGestures(enabled: Bool, exploring: Bool) -> Bool { enabled && !exploring }
    static func title(exploring: Bool) -> String { exploring ? "Ferma esplorazione" : "Esplora" }
    static func command(exploring: Bool) -> [String: Any] { ["on": !exploring] }
    static func note(exploring: Bool, rover: Bool) -> String {
        if exploring { return rover ? "Robottino gira per la stanza e dice che cosa vede." : "Portalo in giro e inquadra le cose: dice che cosa vede." }
        return rover ? "Gira con il rover per tre minuti e dice che cosa vede." : "Senza rover: lo porti tu in mano e lui dice che cosa vede."
    }
    /// What a refusal means, in plain words.
    static func refused(_ error: Error) -> String { "Il robot non ha potuto: \((error as? LocalizedError)?.errorDescription ?? "riprova tra un attimo.")" }
}

enum RobotFollowHelp {
    /// `every` was 0.2 and one answer at a time until the owner asked for speed (15 Nov 2026, evening: on the robot's
    /// log three answers a second, each about a third of a second after its frame): now two may be on their way.
    static let key = "robot.follow.help", every = 0.08, inFlight = 2
    /// The middle of the face as the robot wants it: 0…1, x from the left, y from the TOP. The box is Vision's (y up).
    static func target(minX: Double, minY: Double, width: Double, height: Double) -> (x: Double, y: Double)? {
        guard [minX, minY, width, height].allSatisfy(\.isFinite), width > 0.02, height > 0.02 else { return nil }
        return (min(1, max(0, minX + width / 2)), min(1, max(0, 1 - (minY + height / 2))))
    }
    /// Two answers on their way at most, only about a frame that has a number (the JPEG video), and only
    /// when the robot can move its head (otherwise it has nothing to do with it).
    static func shouldSend(enabled: Bool, ready: Bool, motion: Bool, pending: Int, frame: UInt32, since: Double) -> Bool {
        enabled && ready && motion && pending < inFlight && frame > 0 && since >= every
    }
}

/// The link the app opens by itself (owner, 15 Nov 2026: «appena apro l'app si connette al robot automaticamente»):
/// one shared link for the whole app, opened whenever the app is in front and no other page has its own (the relay
/// takes one app link at a time: Test, Aspetto and the quick commands of the Robot tab open theirs, and this one
/// steps aside for them). When it cannot connect it tries again, each time a little later.
enum RobotAutoLink {
    static let enabledKey = "robot.link.auto"
    /// Seconds before the next try after `failures` tries in a row: 3, 6, 12, 24, then every 30.
    static func delay(failures: Int) -> Double { min(30, 3 * pow(2, Double(max(0, min(failures, 6))))) }
    static func shouldConnect(enabled: Bool, active: Bool, hasToken: Bool, open: Bool, otherPages: Int, busy: Bool) -> Bool {
        enabled && active && hasToken && !open && otherPages == 0 && !busy
    }
    /// The relay gives the robot to the newest app link (23 Nov 2026) and tells the old one `app_replaced`: the shared
    /// link then waits until the app comes back to the front, so two links never take the robot from each other.
    static func takesBack(after reason: String?) -> Bool { reason != "app_replaced" }
    /// Hand gestures by themselves on that link (owner, the same day: «abilitiamo anche in automatico il riconoscimento
    /// dei gesti quando è collegato»): while the robot is connected and has its camera, and the Live page, which has
    /// its own video and gestures, is not open.
    static let gesturesKey = "robot.gestures.auto", sightKey = "robot.sight.auto", ownerNameKey = "robot.sight.name", ownerPrintsKey = "robot.sight.prints"
    static func wantsGestures(link: Bool, gestures: Bool, liveOpen: Bool, ready: Bool, camera: Bool) -> Bool { link && gestures && !liveOpen && ready && camera }
}

/// What the Robot tab writes after a switch («Movimenti della testa», «Inseguimento con rover») that the robot took
/// (code review, 15 Nov 2026). `state` is what the robot's own status says after the wait, nil when it said nothing.
/// The robot's refusal has its own text in the view; here the command was acknowledged, so a state that has not
/// changed yet is «still on its way», not «refused» (the motors can take longer than the wait to answer).
enum RobotRemoteSwitchNote {
    /// Tenths of a second the app waits for the robot's status to change after the acknowledgement.
    static let waitSteps = 80
    static let pendingOn = "Il robot ha ricevuto il comando, ma non risulta ancora acceso: può volerci qualche secondo. Riapri questa scheda per rileggere lo stato."
    static let pendingOff = "Il robot ha ricevuto il comando, ma risulta ancora acceso: riprova."
    static func text(wanted: Bool, state: Bool?, confirmedOn: String, confirmedOff: String) -> String {
        if state == wanted { return wanted ? confirmedOn : confirmedOff }
        return wanted ? pendingOn : pendingOff
    }
}

/// Temperature, humidity and pressure from the robot's ENV III (owner, 15 Nov 2026: «quando robot collegato segna
/// temperatura e umidità di fianco al titolo Robottino in scheda robot»), in the robot's status (src/robot-wire.ts
/// climate). The title shows them only while the robot is connected and has read them.
struct RobotClimate: Decodable, Equatable {
    var t: Double
    var h: Double
    var p: Double? = nil
    static func title(_ climate: RobotClimate?) -> String {
        guard let c = climate, c.t.isFinite, c.h.isFinite else { return "Robottino" }
        return "Robottino \(Int(c.t.rounded()))° \(Int(c.h.rounded()))%"
    }
}

/// The round stick for the rover (owner, 15 Nov 2026: «un cerchietto che premendolo si muove nelle varie direzioni»).
/// The finger's offset from the centre (screen points, y grows downwards) picks one of the robot's moves: near the
/// centre (`deadZone` of the travel) nothing moves, otherwise the stronger axis wins: up forward, down back, left and
/// right turn on the spot, the safe moves on a desk. Sideways moves stay as two keys. The robot only knows these
/// fixed moves at one speed (MOD ROVER_SPEED): the stick picks a direction, not a speed.
enum RobotRoverStick {
    static let deadZone = 0.35
    static func move(dx: Double, dy: Double, travel: Double) -> RobotRoverKeys.Move? {
        guard travel > 0, dx.isFinite, dy.isFinite, (dx * dx + dy * dy).squareRoot() >= deadZone * travel else { return nil }
        if abs(dy) >= abs(dx) { return dy < 0 ? .forward : .back }
        return dx < 0 ? .turnLeft : .turnRight
    }
}

/// Studio and Live share one connection (owner, 15 Nov 2026: «Collega al robot» at the top of Studio, the rover keys
/// after its menu). Leaving the Live page keeps the link only when nothing there is running or starting: camera,
/// video, call, an image on the robot's screen, following or imitation end with the link closed, as before, so
/// nothing keeps filming or listening once the page is gone.
enum RobotLiveLeave {
    static func keepsLink(camera: Bool, screen: Bool, following: Bool, phoneFollowing: Bool, mirroring: Bool, calling: Bool, busy: Bool) -> Bool {
        !(camera || screen || following || phoneFollowing || mirroring || calling || busy)
    }
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
    case portrait, white, redhead, curly
    var id: String { rawValue }
    var title: String {
        switch self { case .portrait: return "Ritratto"; case .white: return "Robot bianco"; case .redhead: return "Lentiggini"; case .curly: return "Riccia" }
    }
    /// Asset name of one expression: neutral, happy, sad, blink, talk-small, talk-open.
    func image(_ frame: String) -> String {
        switch self { case .portrait: return "Face-\(frame)"; case .white: return "Face-White-\(frame)"; case .redhead: return "Face-Red-\(frame)"; case .curly: return "Face-Curly-\(frame)" }
    }
    /// Band of the 320×240 picture holding eyes and brows: blinking replaces only this band, so a
    /// blink never closes the mouth while speaking.
    var eyeBand: ClosedRange<Double> {
        switch self { case .portrait: return 104...150; case .white: return 82...146; case .redhead: return 120...154; case .curly: return 100...162 } // red: the new pictures of 16 Nov 2026, the eyes at y 137 (closed and open differ on rows 128-147); curly (23 Nov 2026): eyes at y 135, lids from 102 to 160, the talking mouths from 164
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
        case "app_replaced": return "Un altro collegamento dell’app ha preso il robot. \(again)"
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
    /// Set by the app's shared link (RobotSharedLink): it closes itself when another page's client connects, and says so.
    static var beforeOtherConnect: ((RobotLiveClient) -> Bool)?
    private var counted = false
    /// This client is one of the pages counted in `pageClients`; a socket exists (connecting or connected).
    var isCounted: Bool { counted }
    var linkOpen: Bool { socket != nil }
    /// The reason the relay gave the last time it closed this link (nil while connected or after a close of the app).
    private(set) var closeReason: String?
    /// The app went to the background: why the relay closed the link last time no longer counts (23 Nov 2026: after an
    /// `app_replaced` the shared link stayed out even when the app came back to the front, «Collega il robot per iniziare»).
    func forgetCloseReason() { closeReason = nil }
    func connect(token: String) {
        disconnect(); closeReason = nil
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.count >= 32 else { message = "Salva prima il token nella scheda Robot."; return }
        if !automatic { counted = true; Self.pageClients += 1 }
        let followYielded = !automatic && (Self.beforePageConnect?() ?? false), sharedYielded = !automatic && (Self.beforeOtherConnect?(self) ?? false)
        let yielded = followYielded || sharedYielded
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
                self.disconnect(); self.closeReason = reason; self.message = RobotLiveClose.message(reason: reason, status: status, error: error.localizedDescription)
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
            } else if packet.kind == 1 || packet.kind == 8 { cameraFrame = packet; onVideo?(packet) } else if packet.kind == 3 { onAudio?(packet.payload) }
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
    /// What goes with camera.start: this app can show JPEG pictures (media kind 8, 14 Nov 2026). A robot or a server
    /// that does not know them goes on sending the raw picture in pieces, which the app shows as before.
    nonisolated static var cameraStart: [String: Any] { ["jpeg": true] }
    /// At most four commands wait for their answer; STOP is never held back by them (review of 17 Nov 2026, R2), nor
    /// the rover's own stop (code review, 19 Nov 2026) or exploration stop, which the server lets through up to eight.
    nonisolated static func mayQueue(action: String, pending: Int, move: String? = nil, on: Bool? = nil) -> Bool {
        action == "stop" || (action == "rover" && move == "stop" && pending < 8) || (action == "explore" && on == false && pending < 8) || pending < 4
    }
    func command(_ action: String, values: [String:Any] = [:]) async throws {
        guard ready, let socket else { throw RobotLiveError.offline }
        guard Self.mayQueue(action: action, pending: pending.count, move: values["move"] as? String, on: values["on"] as? Bool) else { throw RobotLiveError.busy }
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
    /// A password or a token is never sent back by the robot (host patch `ble-no-secret-echo`, review of 17 Nov 2026,
    /// R3): it only says {"prop": "wifi.password", "value": "", "secret": true, "set": …, "saved": true}. `saved` comes
    /// after every write of it, changed or not. A robot with the older host still echoes the value.
    static func secret(_ data: Data) -> (prop: String, saved: Bool)? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let prop = object["prop"] as? String, prop.hasPrefix("wifi."), object["secret"] as? Bool == true else { return nil }
        return (prop, object["saved"] as? Bool == true)
    }
    /// Notifications are {"prop": "wifi.ssid", "value": …}; returns the pair when present.
    static func notification(_ data: Data) -> (prop: String, value: String)? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let prop = object["prop"] as? String, prop.hasPrefix("wifi.") else { return nil }
        return (prop, object["value"].map { "\($0)" } ?? "")
    }
}

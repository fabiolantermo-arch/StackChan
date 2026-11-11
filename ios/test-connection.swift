// Offline tests against the production RobotStore, using a fake network and vault.
import Foundation
import SwiftUI
import AVFAudio

final class BackendProtocol: URLProtocol {
    static var count = 0
    static var status = 200
    static var authHeaders: [String] = []
    static var requestPaths: [String] = []
    static var requestBodySizes: [Int] = []
    static var errorBody: String?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.count += 1
        Self.requestPaths.append(request.url!.path)
        Self.requestBodySizes.append(request.httpBody?.count ?? 0)
        Self.authHeaders.append(request.value(forHTTPHeaderField: "Authorization") ?? "")
        let body = Self.errorBody ?? (request.url!.path.contains("robot/status")
            ? "{\"connected\":true,\"hardwareVerified\":true,\"calibrated\":true,\"motion\":true,\"camera\":true}"
            : request.url!.path.contains("preferences")
            ? "{\"preferences\":{\"provider\":\"openai\",\"voice\":\"marin\"},\"voices\":{}}"
            : "{\"memories\":[]}")
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct ConnectionTests {
    @MainActor static func main() async {
        func videoChunk(_ id: UInt32, _ offset: Int, _ length: Int, _ sequence: UInt32) -> RobotMediaPacket {
            var body = Data(); for value in [id,UInt32(offset)] { body.append(contentsOf: [UInt8(value >> 24),UInt8((value >> 16) & 255),UInt8((value >> 8) & 255),UInt8(value & 255)]) }
            body.append(Data(repeating: 0x55, count: length))
            return RobotMediaPacket(kind: 4, sequence: sequence, width: 320, height: 240, payload: body)
        }
        var assembler = RobotVideoAssembler(), complete: RobotMediaPacket?
        for (index, offset) in stride(from: 0, to: 153600, by: 32768).enumerated() {
            let chunk = videoChunk(1, offset, min(32768,153600-offset), UInt32(index+1))
            complete = try! assembler.append(RobotMediaPacket.decode(chunk.encoded()), now: 1)
        }
        precondition(complete?.width == 320 && complete?.height == 240 && complete?.payload.count == 153600 && complete?.frameID == 1)
        do { _ = try assembler.append(videoChunk(1,0,32768,6),now: 1); preconditionFailure("Replayed camera frame accepted") } catch {}
        assembler.reset(); _ = try! assembler.append(videoChunk(1,0,32768,1),now: 1)
        precondition(try! assembler.append(videoChunk(1,32768,32768,2),now: 12) == nil)
        assembler.reset(); var hotspotFrame: RobotMediaPacket?
        for (index, offset) in stride(from: 0, to: 153600, by: 32768).enumerated() { hotspotFrame = try! assembler.append(videoChunk(3, offset, min(32768,153600-offset), UInt32(index+1)), now: 1 + Double(index)) }
        precondition(hotspotFrame?.payload.count == 153600, "A colour frame that takes 4 s on the iPhone hotspot still arrives")
        assembler.reset(); _ = try! assembler.append(videoChunk(2,0,32768,1),now: 1)
        do { _ = try assembler.append(videoChunk(2,65536,32768,2),now: 1); preconditionFailure("Missing chunk accepted") } catch {}
        print("PASS 320x240 camera reconstruction, frame replay, timeout and missing chunk validation")
        precondition(RobotFaceSource.allCases == [.robot,.phone])
        var followAssembler = RobotVideoAssembler(), smallFrame: RobotMediaPacket?
        for (index, offset) in [0, 32768].enumerated() {
            var body = Data(); for value in [UInt32(7), UInt32(offset)] { body.append(contentsOf: [UInt8(value >> 24),UInt8((value >> 16) & 255),UInt8((value >> 8) & 255),UInt8(value & 255)]) }
            body.append(Data(repeating: 0x22, count: min(32768, 38400 - offset)))
            smallFrame = try! followAssembler.append(RobotMediaPacket(kind: 4, sequence: UInt32(index + 1), width: 160, height: 120, payload: body), now: 1)
        }
        precondition(smallFrame?.width == 160 && smallFrame?.payload.count == 38400 && smallFrame?.frameID == 7)
        func greyChunk(_ id: UInt32, _ offset: Int, _ length: Int, _ sequence: UInt32, width: Int = 80, height: Int = 60) -> RobotMediaPacket {
            var body = Data(); for value in [id, UInt32(offset)] { body.append(contentsOf: [UInt8(value >> 24),UInt8((value >> 16) & 255),UInt8((value >> 8) & 255),UInt8(value & 255)]) }
            body.append(Data(repeating: 0x80, count: length))
            return RobotMediaPacket(kind: 6, sequence: sequence, width: width, height: height, payload: body)
        }
        var grey: RobotMediaPacket?
        _ = try! followAssembler.append(greyChunk(8, 0, 4096, 3), now: 2)
        grey = try! followAssembler.append(RobotMediaPacket.decode(greyChunk(8, 4096, 704, 4).encoded()), now: 2.1)
        precondition(grey?.kind == 7 && grey?.width == 80 && grey?.height == 60 && grey?.payload.count == 4800 && grey?.frameID == 8, "80x60 grey frame for following, frame number kept")
        precondition((try? grey!.encoded()) != nil, "A grey frame is a valid internal frame")
        do { _ = try greyChunk(9, 0, 4097, 5).encoded(); preconditionFailure("Grey piece over 4 KB accepted") } catch {}
        do { _ = try greyChunk(9, 4800, 1, 5).encoded(); preconditionFailure("Grey piece past the frame accepted") } catch {}
        do { _ = try greyChunk(9, 0, 10, 5, width: 161).encoded(); preconditionFailure("Grey frame wider than 160 accepted") } catch {}
        do { _ = try RobotMediaPacket(kind: 7, sequence: 1, width: 80, height: 60, payload: Data(count: 4799)).encoded(); preconditionFailure("Short grey frame accepted") } catch {}
        _ = try! followAssembler.append(greyChunk(10, 0, 4096, 6), now: 3)
        do { _ = try followAssembler.append(videoChunk(10, 4096, 2, 7), now: 3); preconditionFailure("Colour piece inside a grey frame accepted") } catch {}
        print("PASS 80x60 grey frames for face following: 4 KB pieces, kind 7 inside the app, sizes and mixing checked")
        let found = RobotFaceFollow.target(x: 0.1, y: 0.5, width: 0.3, height: 0.4)!
        precondition(found.x == 0.25 && found.y == 0.3, "centre with y from the top")
        precondition(RobotFaceFollow.target(x: 0.4, y: 0.4, width: 0.05, height: 0.05) == nil && RobotFaceFollow.target(x: .nan, y: 0, width: 0.2, height: 0.2) == nil)
        let follow = RobotFaceFollow.values(frameID: 7, x: 0.25, y: 0.3), json = try! JSONSerialization.data(withJSONObject: follow, options: .sortedKeys)
        let back = try! JSONSerialization.jsonObject(with: json) as! [String: Any], followText = String(data: json, encoding: .utf8)!
        precondition(followText.hasPrefix(#"{"frameId":7,"#) && back["x"] as? Double == 0.25 && back["y"] as? Double == 0.3, followText)
        print("PASS face following: 160x120 robot frames keep their number, face centre from the Vision box, relay track command")
        typealias Box = RobotFaceFollowMemory.Box
        var memory = RobotFaceFollowMemory()
        let whole = memory.seen(Box(x: 0.4, y: 0.3, width: 0.15, height: 0.24), at: 0)!
        precondition(abs(whole.x - 0.475) < 0.001 && abs(whole.y - 0.58) < 0.001, "A whole face: the centre of its box, y from the top")
        let half = memory.seen(Box(x: 0, y: 0.3, width: 0.05, height: 0.24), at: 0.4)!
        precondition(half.x == 0, "Half a face at the left edge (5% wide, once refused): accepted, its centre put back outside the frame, sent as the edge: \(half)")
        let rightCut = memory.seen(Box(x: 0.93, y: 0.3, width: 0.07, height: 0.24), at: 0.8)!
        precondition(abs(rightCut.x - 1) < 0.001, "Cut at the right edge: the hidden part counts, the head turns right: \(rightCut)")
        var fresh = RobotFaceFollowMemory()
        let guessed = fresh.seen(Box(x: 0, y: 0.3, width: 0.1, height: 0.3), at: 0)!
        precondition(abs(guessed.x - 0.004) < 0.002, "No whole face seen yet: its width guessed from the height (0.64 in an 80×60 frame): \(guessed)")
        var past = RobotFaceFollowMemory(); _ = past.seen(Box(x: 0.3, y: 0.3, width: 0.4, height: 0.5), at: 0)
        let beyond = past.seen(Box(x: -0.12, y: 0.3, width: 0.36, height: 0.5), at: 0.4)
        precondition(beyond != nil && abs(beyond!.x - 0.04) < 0.002, "Vision's box past the left edge is kept; its right edge and the width of the whole face seen before give the centre: \(String(describing: beyond))")
        precondition(past.seen(Box(x: 1.0, y: 0.3, width: 0.2, height: 0.2), at: 0.5) == nil, "A box wholly outside the frame is not a face in it")
        precondition(fresh.seen(Box(x: 0.5, y: 0.5, width: 0.04, height: 0.05), at: 0.1) == nil && fresh.seen(Box(x: .nan, y: 0, width: 0.2, height: 0.2), at: 0.2) == nil, "Too small or invalid: ignored")
        var upper = RobotFaceFollowMemory(); let top = upper.seen(Box(x: 0.45, y: 0.85, width: 0.12, height: 0.15), at: 0)
        precondition(top != nil && abs(top!.y - 0.056) < 0.002, "Cut at the top: aimed above the visible part (0.075), where the whole face is: \(String(describing: top))")
        // Leaving the frame: the head goes on the way the face went, then back (owner, 10 Nov 2026: «predici il movimento»).
        let near = Box(x: 0.05, y: 0.3, width: 0.12, height: 0.24)
        var leaving = RobotFaceFollowMemory()
        _ = leaving.seen(near, at: 0)
        precondition(leaving.missing(at: 0.3, frame: 10, free: false) == nil, "An answer is still travelling: no step is used up")
        let step = leaving.missing(at: 0.4, frame: 11)
        precondition(step != nil && step!.x == 0 && step!.y == 0.5, "Lost near the left edge: one step to the left, no higher and no lower: \(String(describing: step))")
        precondition(leaving.missing(at: 0.6, frame: 13) == nil, "Not again before the head has moved (0.8 s)")
        precondition(leaving.missing(at: 1.3, frame: 12) == nil, "Nor on the frame right after the step: it was taken before the head moved")
        precondition(leaving.missing(at: 1.3, frame: 13)?.x == 0, "A second step the same way")
        precondition(leaving.missing(at: 2.0, frame: 15) == nil, "Then 1.2 s for the head to get there")
        let back1 = leaving.missing(at: 2.6, frame: 16), early = leaving.missing(at: 3.0, frame: 18), back2 = leaving.missing(at: 3.9, frame: 19)
        precondition(back1?.x == 1 && back1?.y == 0.5 && early == nil && back2?.x == 1, "Still nobody: the two steps undone, the head goes back where it saw the face")
        precondition(leaving.missing(at: 6, frame: 30) == nil && leaving.missing(at: 20, frame: 90) == nil, "Then the head stays until someone is seen")
        let centred = Box(x: 0.42, y: 0.3, width: 0.15, height: 0.24)
        var middle = RobotFaceFollowMemory(); _ = middle.seen(centred, at: 0)
        precondition(middle.missing(at: 0.4, frame: 5) == nil && middle.missing(at: 2.9, frame: 9) == nil, "Lost in the middle of the frame (a blink, a hand): the head stays")
        let around = [middle.missing(at: 3.1, frame: 10), middle.missing(at: 3.5, frame: 12), middle.missing(at: 4.4, frame: 11), middle.missing(at: 4.4, frame: 13),
                      middle.missing(at: 5.7, frame: 16), middle.missing(at: 7.0, frame: 19), middle.missing(at: 9, frame: 25)].map { $0.map { "\($0.x)/\($0.y)" } ?? "-" }.joined(separator: " ")
        precondition(around == "0.0/0.5 - - 1.0/0.5 1.0/0.5 0.0/0.5 -", "Nobody for 3 s: one look around (a side, back, the other side, back), 1.2 s and a new frame apart, then the head stays: \(around)")
        let offCentre = Box(x: 0.6, y: 0.38, width: 0.15, height: 0.24)
        var leaning = RobotFaceFollowMemory(); _ = leaning.seen(offCentre, at: 0, small: true)
        precondition(leaning.missing(at: 0.4, frame: 3)?.x == 1, "A small image is cut around where the face was: a face right of its centre was going right, the head goes on that way")
        var wide = RobotFaceFollowMemory(); _ = wide.seen(offCentre, at: 0)
        precondition(wide.missing(at: 0.4, frame: 3) == nil, "The same place in a whole image says nothing: the head stays")
        var rising = RobotFaceFollowMemory(); _ = rising.seen(Box(x: 0.42, y: 0.6, width: 0.15, height: 0.24), at: 0, small: true)
        let upward = rising.missing(at: 0.4, frame: 3)
        precondition(upward?.x == 0.5 && upward?.y == 0, "Going up in a small image and gone (someone standing up): a step up, not sideways: \(String(describing: upward))")
        precondition(rising.missing(at: 1.3, frame: 5)?.y == 0 && rising.missing(at: 2.6, frame: 8)?.y == 1 && rising.missing(at: 3.9, frame: 11)?.y == 1 && rising.missing(at: 6, frame: 20) == nil, "A second step up, then both undone")
        var old = RobotFaceFollowMemory(); _ = old.seen(Box(x: 0.02, y: 0.3, width: 0.12, height: 0.24), at: 0)
        precondition(old.missing(at: 2, frame: 5) == nil, "Lost long ago (over 1.2 s): no step that way")
        precondition(old.missing(at: 3.2, frame: 8)?.x == 0, "After 3 s the look around, starting on the side where the face was")
        var again = RobotFaceFollowMemory(); _ = again.seen(near, at: 0)
        _ = again.missing(at: 0.4, frame: 1); _ = again.missing(at: 1.3, frame: 3); _ = again.seen(near, at: 1.6)
        precondition(again.missing(at: 2.0, frame: 5)?.x == 0 && again.missing(at: 2.9, frame: 7)?.x == 0, "Seen again: a new loss searches again from the start")
        var restarted = RobotFaceFollowMemory(); _ = restarted.seen(near, at: 0); _ = restarted.missing(at: 0.4, frame: 900)
        precondition(restarted.missing(at: 1.3, frame: 2)?.x == 0, "The robot's frame numbers started again: this is a new frame")
        var body = RobotFaceFollowMemory()
        let head = body.seenBody(Box(x: 0.3, y: 0.0, width: 0.4, height: 0.7), at: 0)!
        precondition(abs(head.x - 0.5) < 0.001 && abs(head.y - 0.44) < 0.001, "A person without a visible face: aim at the top of the body, where the head is: \(head)")
        precondition(body.seenBody(Box(x: 0.3, y: 0.3, width: 0.05, height: 0.05), at: 0.1) == nil, "A tiny body box is ignored")
        var start = RobotFaceFollowMemory()
        precondition(start.missing(at: 0, frame: 1) == nil && start.missing(at: 0.4, frame: 2) == nil, "Nobody yet: a moment to look first")
        precondition(start.missing(at: 0.7, frame: 3, free: false) == nil, "Not while an answer is travelling")
        let lookUp = start.missing(at: 0.7, frame: 3)
        precondition(lookUp?.x == 0.5 && lookUp?.y == 0, "Still nobody: the head looks up (someone sitting close is above the robot)")
        precondition(start.missing(at: 1.2, frame: 4) == nil && start.missing(at: 1.8, frame: 5)?.y == 0 && start.missing(at: 3, frame: 8) == nil, "Twice at most, 1 s apart")
        _ = start.seen(Box(x: 0.4, y: 0.1, width: 0.15, height: 0.24), at: 3.2)
        precondition(start.missing(at: 3.6, frame: 9) == nil, "Found: the usual rules from then on (lost in the middle: the head stays)")
        print("PASS face following memory: half faces at the edges, a face that left the frame (two steps its way, then back), a look around after 3 s, steps only when an answer can leave and on a new frame, a person from behind, looking up at the start")
        let right = RobotHeadJoystick.target(x: 1, y: -1), down = RobotHeadJoystick.target(x: -0.04, y: 1), far = RobotHeadJoystick.target(x: 5, y: .nan)
        precondition(right.yaw == 90 && right.pitch == -85 && down.yaw == -4 && down.pitch == 0 && far.yaw == 0 && far.pitch == 0, "90° sideways, 85° up, never down, whole degrees")
        precondition(RobotHeadJoystick.target(x: -0.55, y: -0.31) == (yaw: -50, pitch: -26))
        // «Seguimi con la fotocamera dell’iPhone»: where the phone sees the face is where the head goes.
        let centre = RobotPhoneFollow.aim(x: 0.4, y: 0.4, width: 0.2, height: 0.2, fieldOfView: 60), rightUp = RobotPhoneFollow.aim(x: 0.8, y: 0.8, width: 0.2, height: 0.2, fieldOfView: 60), low = RobotPhoneFollow.aim(x: 0, y: 0, width: 0.2, height: 0.2, fieldOfView: 60)
        precondition(centre! == (yaw: 0, pitch: 0), "A face in the middle: straight ahead")
        precondition(rightUp!.yaw > 15 && rightUp!.yaw < 25 && rightUp!.pitch < -20 && rightUp!.pitch > -30, "Right of the mirrored image: to the right; above the middle: up, by the camera's own angles")
        precondition(low!.yaw < -15 && low!.pitch == 0, "Left, and never below straight ahead")
        precondition(RobotPhoneFollow.aim(x: .nan, y: 0, width: 0.2, height: 0.2, fieldOfView: 60) == nil && RobotPhoneFollow.aim(x: 0, y: 0, width: 0, height: 0.2, fieldOfView: 60) == nil && RobotPhoneFollow.aim(x: 0, y: 0, width: 0.2, height: 0.2, fieldOfView: 5) == nil, "Nonsense gives no command")
        let side = RobotPhoneFollow.aim(x: 0.8, y: 0.8, width: 0.2, height: 0.2, fieldOfView: 60, landscape: true)
        precondition(side!.yaw > rightUp!.yaw && side!.pitch > rightUp!.pitch, "Phone on its side: the wide angle is the horizontal one (10 Nov 2026: with the phone lying down the head looked the wrong way)")
        let phoneLeaning = RobotPhoneFollow.aim(x: 0.4, y: 0.4, width: 0.2, height: 0.2, fieldOfView: 60, tilt: 25)
        precondition(phoneLeaning! == (yaw: 0, pitch: -25) && RobotPhoneFollow.aim(x: 0.4, y: 0.4, width: 0.2, height: 0.2, fieldOfView: 60, tilt: -10)! == (yaw: 0, pitch: 0) && RobotPhoneFollow.aim(x: 0.4, y: 0.4, width: 0.2, height: 0.2, fieldOfView: 60, tilt: 120) == nil, "A phone leaning back looks up by that much; never below straight ahead; nonsense gives no command")
        precondition(RobotPhoneFollow.start.yaw == 0 && RobotPhoneFollow.start.pitch < -20 && RobotPhoneFollow.start.pitch >= -RobotHeadJoystick.upLimit, "At the start the head looks up, where the owner's face usually is")
        precondition(RobotPhoneFollow.moved((yaw: 10, pitch: -5), from: nil) && !RobotPhoneFollow.moved((yaw: 11, pitch: -5), from: (yaw: 10, pitch: -5)) && RobotPhoneFollow.moved((yaw: 12, pitch: -5), from: (yaw: 10, pitch: -5)) && RobotPhoneFollow.moved((yaw: 10, pitch: -7), from: (yaw: 10, pitch: -5)), "Only changes of 2° or more are sent")
        precondition(RobotHeadJoystick.command(yaw: 30, pitch: -10) == ["yaw": 30, "pitch": -10] && RobotHeadJoystick.command(yaw: -90, pitch: 0) == ["yaw": -90, "pitch": 0], "The robot reverses its own yaw servo (MOD YAW_SERVO): the angles go as they are")
        print("PASS Test page joystick: real head up to 90° sideways and 85° up, never down")
        func liveStatus(conversation: Bool?, motion: Bool = true, camera: Bool = true, connected: Bool = true, simulated: Bool? = nil) -> RobotLiveStatus {
            RobotLiveStatus(connected: connected, hardwareVerified: true, calibrated: true, motion: motion, motionEnabled: motion, camera: camera, audio: true, screen: true, simulated: simulated, conversation: conversation)
        }
        precondition(RobotConversationFollowRule.shouldStart(liveStatus(conversation: true), enabled: true, pageOpen: false), "A conversation with motions and camera ready: follow")
        precondition(!RobotConversationFollowRule.shouldStart(liveStatus(conversation: nil), enabled: true, pageOpen: false), "An older robot that does not say: never")
        precondition(!RobotConversationFollowRule.shouldStart(liveStatus(conversation: true), enabled: false, pageOpen: false) && !RobotConversationFollowRule.shouldStart(liveStatus(conversation: true), enabled: true, pageOpen: true), "Switched off, or a page uses the Live channel")
        precondition(!RobotConversationFollowRule.shouldStart(liveStatus(conversation: true, motion: false), enabled: true, pageOpen: false) && !RobotConversationFollowRule.shouldStart(liveStatus(conversation: true, camera: false), enabled: true, pageOpen: false) && !RobotConversationFollowRule.shouldStart(liveStatus(conversation: true, simulated: true), enabled: true, pageOpen: false))
        precondition(RobotConversationFollowRule.shouldStop(liveStatus(conversation: false), enabled: true, pageOpen: false) && RobotConversationFollowRule.shouldStop(nil, enabled: true, pageOpen: false) && RobotConversationFollowRule.shouldStop(liveStatus(conversation: true), enabled: true, pageOpen: true), "Conversation over, link lost or a page opened: stop")
        precondition(!RobotConversationFollowRule.shouldStop(liveStatus(conversation: true), enabled: true, pageOpen: false))
        precondition(RobotFaceFollow.accepts(confidence: 0.75) && RobotFaceFollow.accepts(confidence: 0.5) && !RobotFaceFollow.accepts(confidence: 0.49) && !RobotFaceFollow.accepts(confidence: .nan), "A backlit face from the robot camera (0.75) is followed")
        print("PASS face following during a conversation: starts and stops on the robot's state; backlit faces are followed")
        print("PASS robot camera is the default available face source alongside optional phone camera")
        let videoPacket = RobotMediaPacket(kind: 1, sequence: 42, width: 160, height: 120, payload: Data(repeating: 0x7f, count: 38400))
        let wire = try! videoPacket.encoded(), decoded = try! RobotMediaPacket.decode(wire)
        precondition(wire.count == 38412 && decoded.sequence == 42 && decoded.payload == videoPacket.payload)
        let audioPacket = RobotMediaPacket(kind: 3, sequence: 43, width: 0, height: 0, payload: Data(repeating: 0, count: 640))
        precondition((try! RobotMediaPacket.decode(audioPacket.encoded())).payload.count == 640)
        print("PASS production media wire round-trips RGB565 and PCM16 with bounded packet sizes")
        do {
            // Audio of the Live call: the same values as firmware/stackchan-mod/live-wire.test.mjs.
            func pcm(_ samples: [Int]) -> Data { var data = Data(capacity: samples.count * 2); for s in samples { let v = UInt16(bitPattern: Int16(s)); data.append(UInt8(v & 0xFF)); data.append(UInt8(v >> 8)) }; return data }
            func steady(_ value: Int) -> [UInt8] { var packer = RobotCallAudio.Packer(); return Array(packer.add(pcm(Array(repeating: value, count: 1600)))[0].dropFirst(2).prefix(3)) }
            func heard(_ law: [UInt8], _ player: inout RobotCallAudio.Player) -> [Int] { player.samples(Data(RobotCallAudio.marker + law))!.map { Int($0) } }
            var silentPacker = RobotCallAudio.Packer(); let silent = silentPacker.add(Data(count: 3200))
            precondition(silent.count == 1 && silent[0].count == 802 && Array(silent[0].prefix(2)) == [0xB1, 0x08])
            precondition(silent[0].dropFirst(2).allSatisfy { $0 == 0xFF })
            precondition(steady(1000) == [0xD4, 0xCE, 0xCE]); precondition(steady(-1000) == [0x54, 0x4E, 0x4E])
            precondition(steady(32767) == [0x87, 0x80, 0x80]); precondition(steady(-32768) == [0x07, 0x00, 0x00])
            precondition(steady(-1) == [0x7F, 0x7F, 0x7F]); precondition(steady(0) == [0xFF, 0xFF, 0xFF])
            var player = RobotCallAudio.Player()
            precondition(heard([0xCE, 0xCE, 0x4E, 0x4E], &player) == [494, 988, 988, 988, 0, -988, -988, -988])
            player.clear(); precondition(heard([0x80, 0x00], &player) == [16062, 32124, 0, -32124])
            player.clear(); precondition(heard([0xFF, 0x7F], &player) == [0, 0, 0, 0])
            player.clear(); _ = heard([0xCE, 0xCE], &player); precondition(player.last == 988)
            precondition(heard([0xCE, 0xCE], &player) == [988, 988, 988, 988])
            let levels: [Int] = (0..<3200).map { ($0 * 7919) % 65536 - 32768 }, whole = pcm(levels)
            var packer = RobotCallAudio.Packer(); let pieces = packer.add(whole)
            var sum = 0, mix = 0
            for piece in pieces { for byte in piece.dropFirst(2) { sum += Int(byte); mix = (mix * 31 + Int(byte)) % 65521 } }
            precondition(pieces.count == 2 && sum == 146413 && mix == 4571)
            precondition(Array(pieces[0].dropFirst(2).prefix(6)) == [9, 15, 76, 146, 148, 13])
            player.clear(); var total = 0, mixed = 0
            for piece in pieces { for sample in player.samples(piece)! { total += Int(sample); mixed = (mixed * 31 + Int(UInt16(bitPattern: sample))) % 65521 } }
            precondition(total == -163170 && mixed == 7895 && player.last == -4604)
            // Reads of any size make the same pieces; an odd sample waits for the next read, a stray byte is left out.
            var cut = RobotCallAudio.Packer(), parts = [Data]()
            for (from, to) in [(0, 1), (1, 2), (2, 5), (5, 6), (6, 807), (807, 1600), (1600, 1601), (1601, 2999), (2999, 3200)] { parts += cut.add(whole.subdata(in: from * 2..<to * 2)) }
            precondition(parts == pieces)
            var stray = RobotCallAudio.Packer(); precondition(stray.add(Data(count: 3203)).count == 1)
            var cleared = RobotCallAudio.Packer(); precondition(cleared.add(whole.prefix(2002)).isEmpty); cleared.clear(); precondition(cleared.add(whole) == pieces)
            // Only this format is call audio: the marker, an even number of bytes, 0.2 s at most.
            let mark: [UInt8] = [0xB1, 0x08]
            precondition(RobotCallAudio.length(pieces[0]) == 800 && RobotCallAudio.length(Data(mark + [UInt8](repeating: 0xFF, count: 1600))) == 1600)
            precondition(RobotCallAudio.length(Data(mark + [0xFF, 0xFF])) == 2 && RobotCallAudio.length(Data(count: 640)) == 0 && RobotCallAudio.length(Data()) == 0)
            precondition(RobotCallAudio.length(Data(mark)) == 0 && RobotCallAudio.length(Data(mark + [0xFF, 0xFF, 0xFF])) == 0)
            precondition(RobotCallAudio.length(Data(mark + [UInt8](repeating: 0xFF, count: 1602))) == 0)
            precondition(RobotCallAudio.length(Data([0xB1, 0x09, 0xFF, 0xFF])) == 0 && RobotCallAudio.length(Data([0xB0, 0x08, 0xFF, 0xFF])) == 0)
            precondition(player.samples(Data(count: 640)) == nil, "the 16 kHz PCM16 of before is not played")
            precondition((try! RobotMediaPacket.decode(RobotMediaPacket(kind: 3, sequence: 44, width: 0, height: 0, payload: pieces[0]).encoded())).payload == pieces[0])
            print("PASS call audio: 8 kHz µ-law in pieces of a tenth of a second behind a marker, same values as the robot; anything else is not played")
        }
        for bad in [RobotMediaPacket(kind: 1, sequence: 1, width: 161, height: 120, payload: Data()), RobotMediaPacket(kind: 3, sequence: 0, width: 0, height: 0, payload: Data([1,2])), RobotMediaPacket(kind: 3, sequence: 1, width: 0, height: 0, payload: Data([1]))] {
            do { _ = try bad.encoded(); preconditionFailure("Invalid media accepted") } catch {}
        }
        var corruptPacket = wire; corruptPacket[0] = 0
        do { _ = try RobotMediaPacket.decode(corruptPacket); preconditionFailure("Bad header accepted") } catch {}
        precondition(RobotFacePose(yaw: 10, pitch: -10, leftEye: 0, rightEye: 1, mouth: 0.5).valid())
        precondition(!RobotFacePose(yaw: .nan, pitch: 0, leftEye: 1, rightEye: 1, mouth: 0).valid())
        precondition(!RobotFacePose(yaw: 11, pitch: 0, leftEye: 1, rightEye: 1, mouth: 0).valid())
        print("PASS invalid media, replay sequence zero, and unsafe face/head values are rejected")

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BackendProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var saved = "test-only-token"
        var saves = 0
        let store = RobotStore(loadToken: { saved }, saveToken: { saved = $0; saves += 1 }, session: session)
        precondition(store.token == saved)
        await store.restoreConnection()
        precondition(store.connected && store.provider == "openai" && BackendProtocol.count == 2)
        precondition(saves == 0, "Startup must reuse the vault without rewriting it")
        await store.restoreConnection()
        precondition(store.connected && BackendProtocol.count == 4, "Foreground must recheck the backend")
        precondition(BackendProtocol.authHeaders.allSatisfy { $0 == "Bearer test-only-token" })
        print("PASS saved token restored and foreground connection refreshed automatically")

        store.token = "  replacement-test-token\n"
        await store.connect()
        precondition(store.connected && saved == "replacement-test-token" && saves == 1)
        let relaunched = RobotStore(loadToken: { saved }, session: session)
        await relaunched.restoreConnection()
        precondition(relaunched.connected && relaunched.token == saved)
        print("PASS valid token saved once and reused after app relaunch")

        BackendProtocol.status = 401
        store.token = "invalid-test-token"
        await store.connect()
        precondition(!store.connected && saved == "replacement-test-token" && saves == 1)
        await relaunched.restoreConnection()
        precondition(!relaunched.connected && relaunched.status.contains("Token non valido"))
        print("PASS invalid credentials do not overwrite the saved token or report connected")

        BackendProtocol.status = 400; BackendProtocol.errorBody = "{\"error\":\"secret_not_allowed\"}"
        await relaunched.saveMemory("dato di prova")
        precondition(!relaunched.lastSucceeded && relaunched.status.contains("password"), "Rejected memories must explain why")
        BackendProtocol.errorBody = "{\"error\":\"unexpected\"}"
        await relaunched.saveMemory("dato di prova")
        precondition(relaunched.status == "Operazione non riuscita (400).")
        BackendProtocol.errorBody = nil
        precondition(RobotMemoryItem(id: "a", text: "x", kind: "fact").kindName == "Detto a voce")
        print("PASS backend error codes become readable Italian messages; memory kinds are translated")

        let requests = BackendProtocol.count
        let empty = RobotStore(loadToken: { "" }, session: session)
        await empty.restoreConnection()
        precondition(!empty.connected && BackendProtocol.count == requests)
        print("PASS missing token prompts setup without network requests")

        let diagnostics = RobotTests()
        let beforeSimulation = BackendProtocol.count
        diagnostics.move(x: 1, y: 1)
        precondition(diagnostics.yaw == 0 && diagnostics.pitch == 0, "Neither simulation nor the real robot: the joystick does nothing")
        diagnostics.simulation = true
        diagnostics.move(x: 3, y: -3)
        precondition(diagnostics.yaw == 90 && diagnostics.pitch == -85, "Simulation uses the robot's range: 90° sideways, 85° up")
        diagnostics.move(x: -3, y: 1)
        precondition(diagnostics.yaw == -90 && diagnostics.pitch == 0, "The K151 head never looks down")
        diagnostics.stop()
        precondition(diagnostics.yaw == 0 && diagnostics.pitch == 0)
        precondition(BackendProtocol.count == beforeSimulation, "Simulation must never send robot commands")
        print("PASS movement simulation is bounded and sends no network commands")

        diagnostics.simulation = false
        BackendProtocol.status = 200
        await diagnostics.check(using: relaunched)
        precondition(diagnostics.caps?.hardwareVerified == true && diagnostics.status.hasPrefix("Robot collegato. Hardware verificato: sì"), diagnostics.status)
        precondition(!diagnostics.canDrive && !diagnostics.driving && diagnostics.status.contains("attiva Hardware, Calibrazione e Movimenti"), "Without motions on, the real joystick stays off and says how to turn them on")
        BackendProtocol.errorBody = "{\"connected\":true,\"hardwareVerified\":true,\"calibrated\":true,\"motion\":true,\"camera\":true,\"motionEnabled\":true}"
        await diagnostics.check(using: relaunched)
        precondition(diagnostics.canDrive && !diagnostics.driving, "Motions on: the real joystick can start, but only on request")
        BackendProtocol.errorBody = "{\"connected\":false,\"hardwareVerified\":false,\"calibrated\":false,\"motion\":false,\"camera\":false,\"motionEnabled\":false}"
        await diagnostics.check(using: relaunched)
        precondition(!diagnostics.canDrive && diagnostics.status.contains("non è collegato al servizio"))
        BackendProtocol.errorBody = nil
        BackendProtocol.status = 404
        await diagnostics.check(using: relaunched)
        precondition(diagnostics.caps == nil && !diagnostics.canDrive && diagnostics.status.hasPrefix("Verifica robot non riuscita"))
        BackendProtocol.status = 200
        print("PASS Test page reads the real robot state; the real joystick needs motions on and an explicit start")

        let networkCount = BackendProtocol.count
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("robottino-studio-tests-\(UUID())")
        let url = directory.appendingPathComponent("dances.json")
        let simulated = StudioSimulator(delay: { _ in await Task.yield() })
        let studio = RobotStudio(storageURL: url, simulator: simulated)
        studio.save()
        precondition(studio.library.count == 1)
        let originalID = studio.draft.id
        studio.draft.name = "Saluto modificato"; studio.save()
        precondition(studio.library.count == 1 && studio.library[0].name == "Saluto modificato")
        studio.duplicate(); precondition(studio.draft.id != originalID); studio.save()
        let reloaded = RobotStudio(storageURL: url)
        precondition(reloaded.library.count == 2)
        reloaded.delete(reloaded.library[0]); precondition(reloaded.library.count == 1)
        let attributes = try! FileManager.default.attributesOfItem(atPath: url.path)
        precondition((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        print("PASS dance create, rename, duplicate, reload and delete persist privately")

        let exported = try! studio.exportDraft()
        let imported = RobotStudio(storageURL: directory.appendingPathComponent("import.json"))
        try! imported.importDance(exported)
        precondition(imported.draft.name == studio.draft.name && imported.draft.id != studio.draft.id)
        precondition(imported.library.isEmpty, "Import must not auto-save or replace existing dances")
        let beforeBadImport = imported.draft
        do { try imported.importDance(Data("{\"version\":99}".utf8)); preconditionFailure("Bad file accepted") } catch {}
        do { try imported.importDance(Data(repeating: 65, count: 65537)); preconditionFailure("Oversized file accepted") } catch {}
        precondition(imported.draft == beforeBadImport)
        print("PASS export/import preserves steps with fresh IDs and rejects bad files without mutation")

        var invalid = StudioDance()
        invalid.frames[0].yaw = .nan
        do { try invalid.validate(); preconditionFailure("NaN accepted") } catch {}
        invalid.frames = [StudioFrame(durationMs: Int.max)]
        do { try invalid.validate(); preconditionFailure("Overflow duration accepted") } catch {}
        invalid.frames = (0..<13).map { _ in StudioFrame(durationMs: 5000) }
        do { try invalid.validate(); preconditionFailure("Long sequence accepted") } catch {}
        invalid.frames = []; do { try invalid.validate(); preconditionFailure("Empty sequence accepted") } catch {}
        let repeated = StudioFrame(); invalid.frames = [repeated, repeated]
        do { try invalid.validate(); preconditionFailure("Duplicate frame ID accepted") } catch {}
        print("PASS finite pose, duration, sequence length and unique frame IDs are validated")

        let corruptURL = directory.appendingPathComponent("corrupt.json")
        let corrupt = Data("not a dance library".utf8); try! corrupt.write(to: corruptURL)
        let damaged = RobotStudio(storageURL: corruptURL); damaged.save()
        precondition(try! Data(contentsOf: corruptURL) == corrupt)
        print("PASS unreadable library is preserved rather than overwritten")

        do { _ = try await simulated.send(StudioFrame()); preconditionFailure("Disconnected command accepted") } catch {}
        await simulated.connect()
        let commandID = UUID(), frame = StudioFrame(yaw: 5, expression: .happy)
        let first = try! await simulated.send(frame, commandID: commandID)
        let duplicate = try! await simulated.send(frame, commandID: commandID)
        precondition(first == duplicate && simulated.lastAck?.sequence == 1)
        do { _ = try await simulated.send(StudioFrame(yaw: -5), commandID: commandID); preconditionFailure("Reused ID with changed payload accepted") } catch {}
        precondition(simulated.pose == frame)
        simulated.failure = .reject
        do { _ = try await simulated.send(StudioFrame(yaw: -5)); preconditionFailure("Rejected command applied") } catch {}
        precondition(simulated.pose == frame)
        simulated.failure = .timeout
        do { _ = try await simulated.send(StudioFrame(yaw: -5)); preconditionFailure("Timeout command applied") } catch {}
        precondition(simulated.link == .fault && simulated.pose == frame)
        print("PASS simulated ACK deduplication, rejection and timeout never apply unconfirmed poses")

        var hold = false
        var continuation: CheckedContinuation<Void, Error>?
        let racing = StudioSimulator(delay: { _ in
            if hold { try await withCheckedThrowingContinuation { continuation = $0 } }
        })
        await racing.connect(); hold = true
        let pendingCommand = Task { try await racing.send(StudioFrame(yaw: 10)) }
        for _ in 0..<50 { if continuation != nil { break }; await Task.yield() }
        precondition(continuation != nil && racing.pending)
        do { _ = try await racing.send(StudioFrame()); preconditionFailure("Overlapping command accepted") } catch {}
        racing.stop(); continuation!.resume()
        do { _ = try await pendingCommand.value; preconditionFailure("Late ACK after STOP accepted") } catch {}
        precondition(racing.pose.yaw == 0 && racing.lastAck == nil && !racing.pending)
        print("PASS STOP invalidates an in-flight command and late ACK; overlapping commands rejected")

        hold = false; await racing.connect(); hold = true; continuation = nil
        let lostCommand = Task { try await racing.send(StudioFrame(yaw: -10)) }
        for _ in 0..<50 { if continuation != nil { break }; await Task.yield() }
        precondition(continuation != nil); racing.disconnect(); continuation!.resume()
        do { _ = try await lostCommand.value; preconditionFailure("Disconnected ACK accepted") } catch {}
        precondition(!racing.connected && racing.pose.yaw == 0)
        print("PASS disconnect drops an in-flight command without reconnecting implicitly")

        simulated.failure = .none; await simulated.connect()
        studio.draft = StudioDance(name: "Test", frames: [StudioFrame(yaw: -5), StudioFrame(yaw: 5), StudioFrame(expression: .blink)])
        studio.play()
        for _ in 0..<500 { if !studio.playing { break }; await Task.yield() }
        precondition(!studio.playing && simulated.pose.expression == .blink && simulated.lastAck?.sequence == 3)
        studio.leave(); precondition(!simulated.connected)
        precondition(BackendProtocol.count == networkCount, "Studio must never contact real backend/robot")
        print("PASS ordered dance playback completes and Studio performs zero network requests")

        hold = true; continuation = nil
        let connecting = Task { await racing.connect() }
        for _ in 0..<50 { if continuation != nil { break }; await Task.yield() }
        precondition(continuation != nil && racing.link == .connecting)
        racing.stop(); continuation!.resume(); await connecting.value
        precondition(racing.link == .disconnected)
        print("PASS STOP cancels a pending connection without leaving a connecting state")

        hold = false; await racing.connect(); hold = true; continuation = nil
        let waiting = Task { try await racing.wait(1000) }
        for _ in 0..<50 { if continuation != nil { break }; await Task.yield() }
        precondition(continuation != nil); racing.disconnect(); continuation!.resume()
        do { try await waiting.value; preconditionFailure("Disconnected frame hold completed") } catch {}
        print("PASS disconnect during a frame hold cannot report successful completion")

        var wave = Data()
        func text(_ string: String) { wave.append(Data(string.utf8)) }
        func u32(_ number: UInt32) { var value = number.littleEndian; withUnsafeBytes(of: &value) { wave.append(contentsOf: $0) } }
        func u16(_ number: UInt16) { var value = number.littleEndian; withUnsafeBytes(of: &value) { wave.append(contentsOf: $0) } }
        text("RIFF"); u32(16036); text("WAVEfmt "); u32(16); u16(1); u16(1); u32(8000); u32(16000); u16(2); u16(16); text("data"); u32(16000); wave.append(Data(repeating: 0, count: 16000))
        let audioURL = directory.appendingPathComponent("sample.wav"); try! wave.write(to: audioURL)
        let defaultStudio = RobotStudio(storageURL: directory.appendingPathComponent("default.json"), defaultMusicURL: audioURL)
        precondition(defaultStudio.draft.musicFile == StudioDance.builtInMusic)
        defaultStudio.removeMusic(); precondition(defaultStudio.draft.musicFile == nil)
        defaultStudio.newDance(); precondition(defaultStudio.draft.musicFile == StudioDance.builtInMusic)
        defaultStudio.removeMusic(); defaultStudio.useDefaultMusic(); precondition(defaultStudio.draft.musicFile == StudioDance.builtInMusic)
        try! defaultStudio.draft.validate()
        print("PASS default dance music can be selected and removed without overwriting imported tracks")
        try! imported.importMusic(from: audioURL); imported.save()
        precondition(imported.draft.musicFile != nil && imported.draft.musicName == "sample.wav")
        let audioReload = RobotStudio(storageURL: directory.appendingPathComponent("import.json"))
        precondition(audioReload.library.first?.musicFile == imported.draft.musicFile)
        let transfer = try! imported.exportDraft()
        try! audioReload.importDance(transfer)
        precondition(audioReload.draft.musicFile == nil, "Imports must never resolve another device's local audio path")
        imported.removeMusic(); precondition(imported.draft.musicFile == nil)
        print("PASS local audio imports and persists; exported dances require a fresh audio selection")

        var unsafeMusic = StudioDance(); unsafeMusic.musicFile = "../../sample.wav"
        do { try unsafeMusic.validate(); preconditionFailure("Unsafe music path accepted") } catch {}
        let invalidAudio = directory.appendingPathComponent("not-a-track.txt"); try! Data("text".utf8).write(to: invalidAudio)
        do { try imported.importMusic(from: invalidAudio); preconditionFailure("Non-audio import accepted") } catch {}
        precondition(BackendProtocol.count == networkCount)
        print("PASS audio path validation and format limits preserve zero network activity")

        var savedNetworks = RobotWiFiProfiles(), networkSaves = 0, networkRemoves = 0
        let networks = RobotNetworkSetup(load: { savedNetworks }, save: { savedNetworks = $0; networkSaves += 1 }, remove: { savedNetworks = RobotWiFiProfiles(); networkRemoves += 1 })
        precondition(networks.profiles.hotspot.ssid == "iPhone 17 Pro Max")
        networks.profiles.home = RobotWiFiProfile(ssid: "Casa", password: "test-only-password")
        precondition(networks.profiles.valid, "An unused default hotspot must not block saving only the home network")
        networks.profiles.home = RobotWiFiProfile(ssid: " home network ", password: "not-a-real-secret")
        networks.profiles.hotspot = RobotWiFiProfile(ssid: "phone-network", password: "test-hotspot-only")
        precondition(networks.saveOnPhone()); precondition(networkSaves == 1 && savedNetworks.home.ssid == " home network ")
        let restoredNetworks = RobotNetworkSetup(load: { savedNetworks }, save: { _ in }, remove: {})
        precondition(restoredNetworks.profiles == savedNetworks && !restoredNetworks.canSendToRobot)
        restoredNetworks.concealDraft(); precondition(restoredNetworks.profiles.home.password.isEmpty && restoredNetworks.profiles.hotspot.password.isEmpty)
        restoredNetworks.restorePasswords(); precondition(restoredNetworks.profiles == savedNetworks)
        networks.profiles.hotspot.ssid = networks.profiles.home.ssid; precondition(!networks.saveOnPhone()); precondition(networkSaves == 1)
        let failingNetworks = RobotNetworkSetup(load: { savedNetworks }, save: { _ in throw URLError(.cannotWriteToFile) }, remove: {})
        precondition(!failingNetworks.saveOnPhone() && failingNetworks.message.contains("non riuscito"))
        precondition(!RobotWiFiProfile(ssid: String(repeating: "à", count: 17), password: "test-only-password").valid)
        precondition(!RobotWiFiProfile(ssid: "network", password: "short").valid)
        networks.clearOnPhone(); precondition(networkRemoves == 1 && savedNetworks.home.empty && savedNetworks.hotspot.empty)
        print("PASS two WiFi profiles persist through injected secure vault, preserve exact SSIDs, reject invalid/duplicate networks and clear draft passwords")
        BackendProtocol.status = 200
        let beforeWiFiCheck = BackendProtocol.count
        await restoredNetworks.check(using: store)
        precondition(BackendProtocol.count == beforeWiFiCheck + 1 && restoredNetworks.online && BackendProtocol.requestPaths.last == "/api/robot/status" && BackendProtocol.requestBodySizes.last == 0)
        precondition(!restoredNetworks.canSendToRobot && restoredNetworks.reach == .online)
        if store.connected { precondition(restoredNetworks.summary(for: store) == "Servizio collegato e robot raggiungibile via internet.", "One sentence for backend and robot") }
        precondition(RobotNetworkSetup(load: { savedNetworks }, save: { _ in }, remove: {}).summary(for: empty).hasPrefix("Non collegato"), "No token: a single setup hint")
        print("PASS WiFi online check uses existing authenticated status; no provisioning is enabled; status is one sentence")

        let openStart = RobotVoiceProtocol.parse("{\"type\":\"session.started\"}", provider: .openai)
        precondition(openStart == [.ready(inputRate: 24000, outputRate: 24000)])
        let elevenStart = RobotVoiceProtocol.parse("{\"type\":\"conversation_initiation_metadata\",\"conversation_initiation_metadata_event\":{\"user_input_audio_format\":\"pcm_16000\",\"agent_output_audio_format\":\"pcm_22050\"}}", provider: .elevenlabs)
        precondition(elevenStart == [.ready(inputRate: 16000, outputRate: 22050)])
        precondition(RobotVoiceProtocol.parse("{\"type\":\"conversation_initiation_metadata\",\"conversation_initiation_metadata_event\":{\"agent_output_audio_format\":\"ulaw_8000\"}}", provider: .elevenlabs) == [.failure("Formato audio del provider non supportato.")])
        let loud = Data((0..<320).flatMap { i -> [UInt8] in let v = Int16(i % 2 == 0 ? 6000 : -6000); return [UInt8(truncatingIfNeeded: v), UInt8(truncatingIfNeeded: v >> 8)] })
        precondition(RobotVoiceProtocol.parse("{\"type\":\"audio\",\"audio_event\":{\"audio_base_64\":\"\(loud.base64EncodedString())\"}}", provider: .elevenlabs) == [.audio(loud)])
        precondition(RobotVoiceProtocol.parse("{\"type\":\"session.output_audio.delta\",\"delta\":\"AQ==\"}", provider: .openai).isEmpty, "Odd-sized PCM is dropped")
        precondition(RobotVoiceProtocol.parse("{\"type\":\"ping\",\"ping_event\":{\"event_id\":7}}", provider: .elevenlabs) == [.pong("7")] && RobotVoiceProtocol.pongMessage("7") == "{\"type\":\"pong\",\"event_id\":7}")
        precondition(RobotVoiceProtocol.parse("{\"type\":\"interruption\"}", provider: .elevenlabs) == [.interrupt] && RobotVoiceProtocol.parse("{\"type\":\"session.input_audio.speech_started\"}", provider: .openai) == [.interrupt])
        precondition(RobotVoiceProtocol.mouthLevel(loud) == 0.8 && RobotVoiceProtocol.mouthLevel(Data(count: 640)) == 0)
        precondition(RobotVoiceProtocol.audioMessage(Data([1, 2]), provider: .openai) == "{\"type\":\"session.input_audio.append\",\"audio\":\"AQI=\"}" && RobotVoiceProtocol.audioMessage(Data([1, 2]), provider: .elevenlabs) == "{\"user_audio_chunk\":\"AQI=\"}")
        var transcript = RobotVoiceTranscript()
        precondition(transcript.apply(.userText("Ricorda che ", final: false)) == nil && transcript.apply(.userText("amo il mare", final: false)) == nil)
        precondition(transcript.apply(.assistantText("Va bene")) == "Ricorda che amo il mare", "OpenAI user turn ends when Robottino answers")
        precondition(transcript.lines.map(\.text) == ["Ricorda che amo il mare", "Va bene"])
        precondition(transcript.apply(.userText("Dimentica tutto", final: true)) == "Dimentica tutto")
        precondition(RobotVoiceProtocol.isMemoryPhrase("Ricorda che amo il mare") && RobotVoiceProtocol.isMemoryPhrase(" dimentica tutto.") && RobotVoiceProtocol.isMemoryPhrase("Robottino, ricordati che piove") && !RobotVoiceProtocol.isMemoryPhrase("Che bella giornata"))
        precondition(RobotVoiceProtocol.parse("{\"type\":\"memory.result\",\"error\":\"invalid_command\"}", provider: .openai).isEmpty, "Ordinary sentences are ignored silently")
        let challenge = RobotVoiceProtocol.parse("{\"type\":\"memory.result\",\"result\":{\"confirmation\":\"tok\",\"requiresConfirmation\":true}}", provider: .openai)
        guard case .memory(_, let token)? = challenge.first, token == "tok" else { preconditionFailure("Clear-all needs an on-screen confirmation") }
        guard case .memory(let note, nil)? = RobotVoiceProtocol.parse("{\"type\":\"memory.result\",\"result\":{\"error\":\"ambiguous\",\"memories\":[]}}", provider: .openai).first, note.contains("più preciso") else { preconditionFailure("Ambiguous forget must not report success") }
        precondition(RobotVoiceProtocol.clearMessage(confirmation: "tok")?.contains("\"confirmation\":\"tok\"") == true)
        print("PASS voice protocol: both providers, audio formats, interruptions, mouth level, transcript turns and memory confirmations")

        precondition(RobotTimerCommand.parse("Robottino, ricordami tra 10 minuti di chiamare la mamma.") == .set(seconds: 600, label: "chiamare la mamma"))
        precondition(RobotTimerCommand.parse("Metti un timer di cinque minuti") == .set(seconds: 300, label: ""))
        precondition(RobotTimerCommand.parse("Svegliami tra mezz’ora") == .set(seconds: 1800, label: ""))
        precondition(RobotTimerCommand.parse("Ricordami tra un’ora e mezza") == .set(seconds: 5400, label: ""))
        precondition(RobotTimerCommand.parse("Timer di 1 ora e 20 minuti") == .set(seconds: 4800, label: ""))
        precondition(RobotTimerCommand.parse("Timer di 30 secondi per la pasta") == .set(seconds: 30, label: "la pasta"))
        precondition(RobotTimerCommand.parse("Avvisami fra un quarto d'ora che devo uscire") == .set(seconds: 900, label: "devo uscire"))
        precondition(RobotTimerCommand.parse("Facciamo un pomodoro") == .pomodoro && RobotTimerCommand.parse("Annulla il timer") == .cancel && RobotTimerCommand.parse("Quanto manca?") == .status)
        precondition(RobotTimerCommand.parse("timer di 2 secondi") == .invalid && RobotTimerCommand.parse("Ricordami che mi piace il mare") == nil && RobotTimerCommand.parse("Che ore sono?") == nil)
        precondition(RobotTimerCommand.duration(4800) == "1 ora e 20 minuti" && RobotTimerCommand.duration(90) == "1 minuto e 30 secondi")
        precondition(RobotReplyMood.from("Sì, certo!") == RobotReplyMood(expression: "neutral", gesture: "nod") && RobotReplyMood.from("Ahahah, che ridere") == RobotReplyMood(expression: "happy", gesture: nil) && RobotReplyMood.from("Ciao! Che bello vederti")?.expression == "neutral" && RobotReplyMood.from("Mi dispiace, non lo trovo.")?.expression == "sad" && RobotReplyMood.from("Mi dispiace, non lo trovo. Però posso cercarlo")?.expression == "neutral" && RobotReplyMood.from("No, non credo.") == RobotReplyMood(expression: "neutral", gesture: "shake"))
        precondition(RobotReplyMood.from("Mi dispiace, non posso.") == RobotReplyMood(expression: "sad", gesture: nil) && RobotReplyMood.from("Come ti chiami?") == RobotReplyMood(expression: "neutral", gesture: "tilt") && RobotReplyMood.from(" ") == nil)
        print("PASS spoken timers and reply mood: same rules as the robot")

        let screenImage = Data((0..<(320 * 240 * 2)).map { UInt8($0 % 251) })
        let screenParts = RobotMediaPacket.screenPieces(frameID: 7, pixels: screenImage)
        precondition(screenParts.count == 5 && screenParts.allSatisfy { $0.count <= 32776 })
        precondition(screenParts.map { $0.dropFirst(8) }.reduce(Data(), +) == screenImage, "Pieces rebuild the whole image")
        precondition(screenParts[1].prefix(8) == Data([0, 0, 0, 7, 0, 0, 0x80, 0]), "Frame id and byte offset are big-endian")
        precondition((try? RobotMediaPacket(kind: 5, sequence: 1, width: 320, height: 240, payload: screenParts[4]).encoded()) != nil)
        precondition((try? RobotMediaPacket(kind: 5, sequence: 1, width: 320, height: 240, payload: Data([0, 0, 0, 1, 0, 2, 0x58, 0]) + Data(count: 4)).encoded()) == nil, "A piece past the end is rejected")
        print("PASS full-resolution screen image: 5 pieces of 32 KB, same layout as the robot camera")

        precondition(RobotFaceStyle.allCases.map(\.rawValue) == ["portrait", "white", "redhead"] && RobotFaceStyle.from("nope") == .portrait)
        precondition(RobotFaceStyle.redhead.image("talk-open") == "Face-Red-talk-open" && !RobotFaceStyle.white.smilesWhileListening)
        let quietPCM = Data(count: 960), loudPCM = Data((0..<480).flatMap { i -> [UInt8] in let v = Int16(i % 2 == 0 ? 3000 : -3000); return [UInt8(truncatingIfNeeded: v), UInt8(truncatingIfNeeded: v >> 8)] })
        precondition(RobotVoiceProtocol.mouthOpenness(quietPCM) == 0 && RobotVoiceProtocol.mouthOpenness(loudPCM) == 1, "Mouth openness: silence closed, loud fully open")
        var mouthSmooth = RobotMouthSmoother(); _ = mouthSmooth.step(toward: 1, at: 0)
        let opened = mouthSmooth.step(toward: 1, at: 0.05); precondition(opened > 0.6 && opened < 1, "Opens in about 45 ms, not instantly")
        for i in 1...30 { _ = mouthSmooth.step(toward: 1, at: 0.05 + Double(i) / 60) }
        let closing = mouthSmooth.step(toward: 0, at: 0.6); precondition(closing > 0.3, "Closes a little slower than it opens")
        for i in 1...60 { _ = mouthSmooth.step(toward: .nan, at: 0.6 + Double(i) / 30) }; precondition(mouthSmooth.value == 0, "Invalid levels close the mouth")
        print("PASS face styles: same ids as relay and robot, image names per style")

        let closed = { (reason: String?, status: Int?) in RobotLiveClose.message(reason: reason, status: status, error: "Socket is not connected") }
        precondition(closed("session_expired", 101).contains("10 minuti") && closed("session_expired", 101).hasSuffix(RobotLiveClose.again))
        precondition(closed("robot_silent", 101).contains("Il robot non dà segnali") && closed("app_silent", 101).contains("L’iPhone non ha raggiunto"))
        precondition(closed("peer_disconnected", 101) == closed("peer_error", 101) && closed("peer_error", 101).contains("si ricollega da solo"))
        precondition(closed("command_timeout", 101) == closed("invalid_ack", 101) && closed("invalid_ack", 101).contains("non ha confermato"))
        precondition(closed("session_timeout", 101).contains("oppure"), "The relay published before 10 Nov gave one reason for two causes")
        precondition(closed("anything", 409).contains("Un’altra app") && closed(nil, 401).contains("Token non valido"), "A refused connection: status first")
        precondition(closed("invalid_media", 101) == "Il servizio ha chiuso il collegamento (invalid_media). \(RobotLiveClose.again)", "Other relay reasons are shown as they are")
        for odd in [nil, "", "Robot <b>", "a b", String(repeating: "a", count: 41), "città"] as [String?] { precondition(closed(odd, nil) == "Collegamento terminato: Socket is not connected", "No reason, or text that is not one of the relay's: the system's error") }
        precondition(![closed("session_expired", 101), closed("robot_silent", 101), closed("rate_limit", 101)].contains { $0.contains("Socket") }, "A known reason never shows the system's words")
        print("PASS Live close reasons: the relay's reason and a refused connection in plain words, the system's error only without one")

        let wifi = RobotWiFiBluetooth.payload(ssid: "Casa Ada’s", password: "pàssword-123")!
        let pieces = RobotWiFiBluetooth.chunks(wifi)
        precondition(pieces.allSatisfy { $0.count <= 60 && String(data: $0, encoding: .utf8) != nil }, "Every BLE write must be valid UTF-8 on its own")
        precondition(pieces.reduce(Data(), +) == wifi)
        let wifiBatch = try! JSONSerialization.jsonObject(with: wifi) as! [String: [String: String]]
        precondition(wifiBatch == ["_batch": ["wifi.ssid": "Casa Ada’s", "wifi.password": "pàssword-123"]])
        precondition(RobotWiFiBluetooth.notification(Data("{\"prop\":\"wifi.ssid\",\"value\":\"Casa\"}".utf8))! == ("wifi.ssid", "Casa"))
        precondition(RobotWiFiBluetooth.notification(Data("{\"prop\":\"tts.volume\",\"value\":3}".utf8)) == nil)
        print("PASS Wi-Fi Bluetooth payload: upstream batch format, 60-byte UTF-8-safe chunks, robot confirmations")
    }
}

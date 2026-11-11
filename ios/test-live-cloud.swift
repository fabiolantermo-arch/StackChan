// Explicit cloud protocol test using the production client; no iPhone sensors or AI providers.
import Foundation
import SwiftUI
@main struct LiveCloudTest {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let token = try String(contentsOf: root.appendingPathComponent("private/robot-token"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let live = RobotLiveClient(); var video = false, audio = false
        live.onVideo = { frame in video = frame.width == 320 && frame.height == 240 && frame.payload.count == 153600 }
        live.onAudio = { data in audio = data.count == 640 }
        live.connect(token: token)
        defer { live.disconnect() }
        for _ in 0..<100 { if live.ready { break }; try await Task.sleep(nanoseconds: 100_000_000) }
        guard live.ready, live.status?.simulated == true else { throw RobotLiveError.offline }
        try await live.command("face.style", values: ["style":"white"])
        try await live.command("camera.start")
        try await live.command("motion", values: ["yaw":5,"pitch":-5])
        try await live.command("mirror", values: ["yaw":1,"pitch":2,"leftEye":0.1,"rightEye":0.9,"mouth":0.5,"followHead":true])
        try await live.command("screen.start")
        live.media(kind: 2, width: 160, height: 120, payload: Data(repeating: 0x55, count: 38400))
        try await live.command("call.start")
        live.media(kind: 3, payload: Data(repeating: 0, count: 640))
        for _ in 0..<50 { if video && audio { break }; try await Task.sleep(nanoseconds: 100_000_000) }
        guard video && audio else { throw RobotLiveError.timeout }
        try await live.command("stop")
        print("PASS production Swift client over Cloudflare: status, 320x240 chunked video, head, face, image, bidirectional PCM and STOP. Virtual device only.")
    }
}

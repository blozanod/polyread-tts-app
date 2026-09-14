import Foundation
import AVFoundation

/// §9 — "`AVAudioSession` category `.playback`, activated on first play." plus
/// "Handle `AVAudioSession.interruptionNotification` and route changes."
@MainActor
public final class AudioSessionManager {

    public enum Event: Sendable {
        case interrupted
        /// The system says it is fine to resume — a phone call ended, say.
        case interruptionEndedShouldResume
        case interruptionEnded
        /// Headphones pulled out. Anything but pausing here is rude.
        case routeDisconnected
    }

    public var onEvent: ((Event) -> Void)?
    private var isConfigured = false

    public init() {
        let center = NotificationCenter.default
        center.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        center.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
    }

    public func activate() throws {
        let session = AVAudioSession.sharedInstance()
        if !isConfigured {
            // `.spokenAudio` is what tells the system this is speech rather than
            // music: it ducks correctly against navigation prompts and behaves
            // properly on CarPlay.
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            isConfigured = true
        }
        try session.setActive(true)
    }

    public func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    @objc private func handleInterruption(_ note: Notification) {
        guard
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }

        switch type {
        case .began:
            onEvent?(.interrupted)
        case .ended:
            let optionsRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
            onEvent?(options.contains(.shouldResume) ? .interruptionEndedShouldResume : .interruptionEnded)
        @unknown default:
            break
        }
    }

    @objc private func handleRouteChange(_ note: Notification) {
        guard
            let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
        else { return }
        if reason == .oldDeviceUnavailable {
            onEvent?(.routeDisconnected)
        }
    }
}

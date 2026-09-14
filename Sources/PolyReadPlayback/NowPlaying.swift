import Foundation
import MediaPlayer
import UIKit
import PolyReadCore

/// §9 — "`MPNowPlayingInfoCenter` ... `MPRemoteCommandCenter`: play, pause, skip
/// forward/back (15 s), change playback position. Lock screen and AirPods
/// controls are the actual point of the app."
@MainActor
public final class NowPlayingController {

    public struct Handlers {
        public var play: () -> Void
        public var pause: () -> Void
        public var skip: (TimeInterval) -> Void
        public var seek: (TimeInterval) -> Void

        public init(
            play: @escaping () -> Void,
            pause: @escaping () -> Void,
            skip: @escaping (TimeInterval) -> Void,
            seek: @escaping (TimeInterval) -> Void
        ) {
            self.play = play
            self.pause = pause
            self.skip = skip
            self.seek = seek
        }
    }

    /// §8.4 — "Skip ±15 s".
    public static let skipInterval: TimeInterval = 15

    private var handlers: Handlers?
    private var info: [String: Any] = [:]

    public init() {}

    public func install(handlers: Handlers) {
        self.handlers = handlers
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.isEnabled = true
        center.playCommand.addTarget { [weak self] _ in
            self?.handlers?.play()
            return .success
        }
        center.pauseCommand.isEnabled = true
        center.pauseCommand.addTarget { [weak self] _ in
            self?.handlers?.pause()
            return .success
        }
        center.togglePlayPauseCommand.isEnabled = true

        center.skipForwardCommand.isEnabled = true
        center.skipForwardCommand.preferredIntervals = [NSNumber(value: Self.skipInterval)]
        center.skipForwardCommand.addTarget { [weak self] event in
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? Self.skipInterval
            self?.handlers?.skip(interval)
            return .success
        }
        center.skipBackwardCommand.isEnabled = true
        center.skipBackwardCommand.preferredIntervals = [NSNumber(value: Self.skipInterval)]
        center.skipBackwardCommand.addTarget { [weak self] event in
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? Self.skipInterval
            self?.handlers?.skip(-interval)
            return .success
        }

        center.changePlaybackPositionCommand.isEnabled = true
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.handlers?.seek(event.positionTime)
            return .success
        }
    }

    /// §9 — "title from the PDF's document title or filename, duration from
    /// Phase A ... Artwork from a rendered thumbnail of page 1."
    public func setMetadata(title: String, duration: TimeInterval, artwork: UIImage?) {
        info[MPMediaItemPropertyTitle] = title
        info[MPMediaItemPropertyPlaybackDuration] = duration
        info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
        if let artwork {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: artwork.size) { _ in artwork }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    /// §9 — "elapsed time from §8.3."
    public func update(elapsed: TimeInterval, rate: Float, isPlaying: Bool) {
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? rate : 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    public func clear() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.removeTarget(nil)
        center.pauseCommand.removeTarget(nil)
        center.skipForwardCommand.removeTarget(nil)
        center.skipBackwardCommand.removeTarget(nil)
        center.changePlaybackPositionCommand.removeTarget(nil)
    }
}

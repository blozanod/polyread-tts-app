import SwiftUI
import PolyReadCore
import PolyReadPlayback

/// §8.4 — play/pause, skip ±15 s, previous/next paragraph, and a scrubber "over
/// the `[WordTiming]` timeline, with the §7.3 buffer edge drawn on it."
public struct TransportBar: View {

    @ObservedObject var playback: PlaybackController
    @State private var scrubbing: TimeInterval?

    public init(playback: PlaybackController) {
        self.playback = playback
    }

    public var body: some View {
        VStack(spacing: 14) {
            scrubber
            controls
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .background(.bar)
    }

    private var displayedPosition: TimeInterval { scrubbing ?? playback.position }

    private var scrubber: some View {
        VStack(spacing: 6) {
            BufferedScrubber(
                value: displayedPosition,
                duration: playback.duration,
                bufferedThrough: playback.renderedThrough,
                onScrub: { scrubbing = $0 },
                onCommit: { time in
                    scrubbing = nil
                    playback.seek(to: time)
                }
            )
            .frame(height: 24)

            HStack {
                Text(Self.timestamp(displayedPosition))
                Spacer()
                // §7.3 — the edge is shown permanently, "like a video preload
                // bar. Most of the time it sits pinned at the end."
                if playback.renderedThrough < playback.duration - 0.5 {
                    Label(
                        "rendered to \(Self.timestamp(playback.renderedThrough))",
                        systemImage: "waveform"
                    )
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(.tertiary)
                }
                Spacer()
                Text("−" + Self.timestamp(max(0, playback.duration - displayedPosition)))
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
        }
    }

    private var controls: some View {
        HStack(spacing: 28) {
            Button { playback.previousBlock() } label: {
                Image(systemName: "backward.end.fill")
            }
            .accessibilityLabel("Previous paragraph")

            Button { playback.skip(by: -NowPlayingController.skipInterval) } label: {
                Image(systemName: "gobackward.15")
            }
            .accessibilityLabel("Back 15 seconds")

            Button { playback.toggle() } label: {
                Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 34))
                    .frame(width: 54, height: 54)
            }
            .accessibilityLabel(playback.isPlaying ? "Pause" : "Play")

            Button { playback.skip(by: NowPlayingController.skipInterval) } label: {
                Image(systemName: "goforward.15")
            }
            .accessibilityLabel("Forward 15 seconds")

            Button { playback.nextBlock() } label: {
                Image(systemName: "forward.end.fill")
            }
            .accessibilityLabel("Next paragraph")
        }
        .font(.system(size: 22))
        .buttonStyle(.plain)
        .overlay(alignment: .trailing) {
            RateButton(rate: $playback.rate)
        }
    }

    static func timestamp(_ seconds: TimeInterval) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds.rounded())
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, secs)
            : String(format: "%d:%02d", minutes, secs)
    }
}

/// §8.2 — speed is `AVAudioUnitTimePitch.rate`, so it changes instantly and
/// invalidates nothing.
struct RateButton: View {
    @Binding var rate: Float
    static let steps: [Float] = [0.8, 1.0, 1.15, 1.25, 1.5, 1.75, 2.0]

    var body: some View {
        Menu {
            ForEach(Self.steps, id: \.self) { step in
                Button {
                    rate = step
                } label: {
                    if abs(rate - step) < 0.01 {
                        Label(Self.label(step), systemImage: "checkmark")
                    } else {
                        Text(Self.label(step))
                    }
                }
            }
        } label: {
            Text(Self.label(rate))
                .font(.footnote.weight(.semibold).monospacedDigit())
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.quaternary, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    static func label(_ rate: Float) -> String {
        String(format: "%gx", (rate * 100).rounded() / 100)
    }
}

/// A scrubber with the rendered-through edge drawn behind the played portion.
struct BufferedScrubber: View {
    let value: TimeInterval
    let duration: TimeInterval
    let bufferedThrough: TimeInterval
    let onScrub: (TimeInterval) -> Void
    let onCommit: (TimeInterval) -> Void

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let safeDuration = max(duration, 0.001)
            let playedWidth = width * min(1, max(0, value / safeDuration))
            let bufferedWidth = width * min(1, max(0, bufferedThrough / safeDuration))

            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary).frame(height: 5)
                Capsule().fill(.tertiary).frame(width: bufferedWidth, height: 5)
                Capsule().fill(.tint).frame(width: playedWidth, height: 5)
                Circle()
                    .fill(.tint)
                    .frame(width: 15, height: 15)
                    .offset(x: playedWidth - 7.5)
                    .shadow(radius: 1, y: 0.5)
            }
            .frame(height: geometry.size.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        onScrub(time(at: drag.location.x, width: width))
                    }
                    .onEnded { drag in
                        onCommit(time(at: drag.location.x, width: width))
                    }
            )
        }
    }

    private func time(at x: CGFloat, width: CGFloat) -> TimeInterval {
        guard width > 0 else { return 0 }
        return duration * Double(min(max(0, x / width), 1))
    }
}

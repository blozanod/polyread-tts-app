import SwiftUI
import PDFKit
import PolyReadCore
import PolyReadPlayback

/// §10 — "Both surfaces read the same `WordTiming` stream. The current word
/// index is one piece of state; the two views are renderers of it."
///
/// §1 — "**One universal target.** Size class selects the listening surface
/// (§10), not a separate app."
public struct ReaderScreen: View {

    @ObservedObject var session: DocumentSession
    @ObservedObject var playback: PlaybackController
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var forcePageView = false

    public init(session: DocumentSession) {
        self.session = session
        self.playback = session.playback
    }

    public var body: some View {
        VStack(spacing: 0) {
            surface
            Divider()
            TransportBar(playback: playback)
        }
        .overlay {
            if session.stage.isLoading {
                ImportProgressView(stage: session.stage)
            }
        }
        .overlay(alignment: .bottom) {
            if let footnote = playback.footnote {
                FootnoteBanner(
                    text: footnoteText(for: footnote.blockID),
                    onDismiss: { playback.endFootnote() }
                )
                .padding(.bottom, 130)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy(duration: 0.22), value: playback.footnote)
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if showsPageSurfaceToggle {
                    Button {
                        forcePageView.toggle()
                    } label: {
                        Image(systemName: forcePageView ? "text.alignleft" : "doc.richtext")
                    }
                    .accessibilityLabel(forcePageView ? "Show reflowed text" : "Show the page")
                }
            }
        }
    }

    /// §10 — regular width gets the rendered page, compact gets reflowed text.
    /// The toggle exists because on an iPad the reflow view is often what you
    /// actually want while listening, and the size class cannot know that.
    private var usesPageSurface: Bool {
        sizeClass == .regular && forcePageView
    }

    private var showsPageSurfaceToggle: Bool {
        sizeClass == .regular && session.pdf != nil
    }

    @ViewBuilder
    private var surface: some View {
        if usesPageSurface, let pdf = session.pdf {
            PageOverlayView(document: pdf, span: currentSpan)
        } else if let reflow = session.reflow {
            ReflowTextView(
                document: reflow,
                blocks: session.blocks,
                highlightedRange: currentSpan?.reflowRange,
                onTapMarker: { playback.interject(footnoteBodyID: $0) },
                onTapWord: { index in
                    playback.seek(to: playback.timeline.startOfWord(index))
                }
            )
        } else {
            ContentUnavailableView(
                "Nothing open",
                systemImage: "doc.text",
                description: Text("Open a PDF to start listening.")
            )
        }
    }

    private var currentSpan: SourceSpan? {
        guard let index = playback.wordIndex,
              index < playback.timeline.words.count
        else { return nil }
        return playback.timeline.words[index].span
    }

    private func footnoteText(for blockID: UUID) -> String {
        session.blocks.first { $0.id == blockID }?.spokenText ?? ""
    }
}

/// §8.5 — while a footnote is playing, the main timeline position must not move,
/// so the transport keeps showing it and this sits on top.
struct FootnoteBanner: View {
    let text: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "text.quote")
                .foregroundStyle(.tint)
            Text(text)
                .font(.footnote)
                .lineLimit(4)
            Spacer(minLength: 0)
            Button(action: onDismiss) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Return to the main text")
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .shadow(radius: 8, y: 2)
        .padding(.horizontal, 16)
    }
}

/// §10 — "**Import:** a progress bar with phase labels (OCR if applicable →
/// Phase A → first audio), dismissing per §7.3."
struct ImportProgressView: View {
    let stage: DocumentSession.Stage

    var body: some View {
        VStack(spacing: 16) {
            ProgressView(value: fraction)
                .progressViewStyle(.linear)
                .frame(width: 260)
            Text(label)
                .font(.callout)
                .foregroundStyle(.secondary)
            if let detail {
                Text(detail)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(28)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background.opacity(0.7))
    }

    private var label: String {
        switch stage {
        case .extracting: return "Reading the PDF"
        case .phonemizing: return "Working out the pronunciation"
        case .phaseA: return "Timing the whole document"
        case .priming: return "Rendering the first minute"
        default: return "Working"
        }
    }

    private var detail: String? {
        switch stage {
        case .extracting(let done, let total):
            return "page \(min(done, total)) of \(total)"
        case .phaseA(let done, let total):
            return "\(done) of \(total) chunks"
        case .priming(let seconds, let target):
            return "\(Int(seconds))s of \(Int(target))s"
        default:
            return nil
        }
    }

    private var fraction: Double {
        switch stage {
        case .extracting(let done, let total):
            return total > 0 ? Double(done) / Double(total) * 0.35 : 0
        case .phonemizing:
            return 0.4
        case .phaseA(let done, let total):
            return total > 0 ? 0.45 + Double(done) / Double(total) * 0.35 : 0.45
        case .priming(let seconds, let target):
            return target > 0 ? 0.8 + min(1, seconds / target) * 0.2 : 0.8
        default:
            return 0
        }
    }
}

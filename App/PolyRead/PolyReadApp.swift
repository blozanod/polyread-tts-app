import SwiftUI
import PolyReadUI

@main
struct PolyReadApp: App {
    @StateObject private var session = DocumentSession()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(session: session)
                // §1 — registered as a PDF document-type handler, so "Open in
                // PolyRead" from Files, Safari and Mail lands here.
                .onOpenURL { url in session.open(url: url) }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: session.applicationDidEnterBackground()
            case .active: session.applicationWillEnterForeground()
            default: break
            }
        }
    }
}

struct RootView: View {
    @ObservedObject var session: DocumentSession

    var body: some View {
        NavigationStack {
            Group {
                switch session.stage {
                case .idle:
                    LibraryScreen(session: session)
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Could not open that PDF", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Back to the library") { session.close() }
                    }
                case .awaitingOCRConfirmation(let summary):
                    // §4.2 — "surface it in the import flow and let the user
                    // decide whether to continue — do not silently synthesize
                    // nonsense, and do not refuse outright."
                    OCRWarningView(
                        summary: summary,
                        onContinue: { session.confirmLowConfidenceImport() },
                        onCancel: { session.cancelImport() }
                    )
                default:
                    ReaderScreen(session: session)
                }
            }
        }
    }
}

struct OCRWarningView: View {
    let summary: DocumentSession.BackendDecisionSummary
    let onContinue: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "text.viewfinder")
                .font(.system(size: 44))
                .foregroundStyle(.orange)
            Text("This scan may not read well")
                .font(.title3.weight(.semibold))
            Text(
                "Neither the embedded text layer nor fresh text recognition scored well on "
                + "this document. It will probably be read aloud as nonsense in places."
            )
            .font(.callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)

            Text(scores)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)

            HStack(spacing: 14) {
                Button("Cancel", role: .cancel, action: onCancel)
                Button("Read it anyway", action: onContinue)
                    .buttonStyle(.borderedProminent)
            }
            .padding(.top, 6)
        }
        .padding(32)
    }

    private var scores: String {
        let embedded = String(format: "%.2f", summary.embeddedScore)
        guard let vision = summary.visionScore else { return "embedded layer \(embedded)" }
        return "embedded layer \(embedded) · recognized text \(String(format: "%.2f", vision))"
    }
}

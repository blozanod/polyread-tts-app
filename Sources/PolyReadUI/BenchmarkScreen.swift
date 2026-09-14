import SwiftUI
import PolyReadBench

/// §0 — the gate, as a screen. Runs on device, answers all three questions, and
/// hands back text that can be pasted into the conversation that asked for them.
public struct BenchmarkScreen: View {

    @Binding var settings: AppSettings
    @State private var report: BenchmarkReport?
    @State private var status: String?
    @State private var isRunning = false

    public init(settings: Binding<AppSettings>) {
        self._settings = settings
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(
                    "Three measurements, on this device. §0 gates the rest of the app on them: "
                    + "the answers change how §7.3 buffers and whether word-level highlighting "
                    + "is possible at all."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)

                if isRunning {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text(status ?? "Running").font(.callout)
                    }
                } else {
                    Button("Run the benchmark") { run() }
                        .buttonStyle(.borderedProminent)
                }

                if let report {
                    Text(report.plainText)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))

                    // §0.2's answer is a setting, so applying it is one tap.
                    if let recommended = report.recommendedPlacement,
                       let placement = AcousticPlacement(rawValue: recommended) {
                        Button("Use \(placement.label) for the acoustic model") {
                            settings.acousticComputeUnits = placement
                            settings.save()
                        }
                        .buttonStyle(.bordered)
                    }

                    ShareLink(item: report.plainText) {
                        Label("Share the report", systemImage: "square.and.arrow.up")
                    }
                }
            }
            .padding(20)
        }
        .navigationTitle("§0 Benchmark")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func run() {
        isRunning = true
        report = nil
        Task {
            let runner = BenchmarkRunner()
            let result = await runner.run(voiceName: settings.voiceName) { message in
                Task { @MainActor in self.status = message }
            }
            await MainActor.run {
                self.report = result
                self.isRunning = false
                self.status = nil
            }
        }
    }
}

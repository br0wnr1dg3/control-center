import SwiftUI

/// Everything published and waiting for a decision, in one place. Reviews don't reach the inbox, so
/// without this the only sign of one is a pill on the board.
struct ReviewsView: View {
    var store = BoardStore.shared
    @State private var showAll = false

    var body: some View {
        let waiting = showAll ? store.awaitingReview : store.myReviews
        let others = store.awaitingReview.count - store.myReviews.count
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if waiting.isEmpty {
                    Text(!showAll && others > 0
                         ? "Nothing is waiting for you. \(others) from other apps are under All."
                         : "Nothing is waiting for review.")
                        .font(.callout).foregroundStyle(.tertiary)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                }
                ForEach(waiting) { task in
                    HStack(spacing: 10) {
                        TaskRow(task: task)
                        if let updated = task.updatedAt {
                            RelativeTime(timestamp: updated).font(.caption).foregroundStyle(.tertiary)
                        }
                        if let link = task.reviewLink {
                            Link("Open review", destination: link)
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                                .help("Open the review page in your browser")
                        }
                    }
                    if task.id != waiting.last?.id { Divider().opacity(0.5).padding(.leading, 34) }
                }
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 20)
            .frame(maxWidth: 1000, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Reviews")
        .navigationSubtitle(waiting.isEmpty ? "" : "\(waiting.count) waiting for a decision")
        .toolbar {
            ToolbarItemGroup {
                // Mine leaves out work sent in by other apps: the people who asked for it there review it.
                Picker("", selection: $showAll) {
                    Text("Mine").tag(false)
                    Text("All").tag(true)
                }
                .pickerStyle(.segmented)
                .fixedSize()
            }
        }
    }
}

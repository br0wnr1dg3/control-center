import SwiftUI

struct MainWindow: View {
    @Bindable var store = BoardStore.shared

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { store.section }, set: { if let s = $0 { store.section = s; store.selectedTaskId = nil } })) {
                Label("Inbox", systemImage: "tray")
                    .badge(store.unreadCount)
                    .tag(Section.inbox)
                Label("Today", systemImage: "sun.max")
                    .badge(store.onYourPlate.count + store.needsYou.count)
                    .tag(Section.today)
                Label("Upcoming", systemImage: "calendar")
                    .tag(Section.upcoming)
                Label("Board", systemImage: "rectangle.split.3x1")
                    .tag(Section.board)

                if !store.projects.isEmpty || store.currentTeam != nil {
                    SwiftUI.Section("Projects") {
                        ForEach(store.projects, id: \.self) { project in
                            Label {
                                Text(project)
                            } icon: {
                                Circle().fill(ProjectColor.of(project)).frame(width: 9, height: 9)
                            }
                            .badge(store.tasks.filter { $0.project == project && $0.status.isOpen }.count)
                            .tag(Section.project(project))
                        }
                        if let team = store.currentTeam {
                            Label("Team settings", systemImage: "gearshape")
                                .foregroundStyle(.secondary)
                                .tag(Section.team(team.id))
                        }
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 210)
            .safeAreaInset(edge: .top) { TeamSwitcher() }
            .safeAreaInset(edge: .bottom) { statusFooter }
        } detail: {
            // An open task takes over the whole content area, like Linear's issue page.
            if let task = store.selectedTask {
                TaskPage(task: task)
            } else {
                switch store.section {
                case .inbox: InboxView()
                case .today: DayView()
                case .upcoming: UpcomingView()
                case .board: BoardView(project: nil)
                case let .project(name): BoardView(project: name)
                case let .team(id):
                    if let team = store.team(id) { TeamSettingsView(team: team) } else { DayView() }
                }
            }
        }
        .frame(minWidth: 1000, minHeight: 600)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { store.compose() } label: { Label("New Task", systemImage: "plus").labelStyle(.titleAndIcon) }
                    .keyboardShortcut("n", modifiers: .command)
                    .help("New task (⌘N)")
            }
            // Keep it its own button rather than merged with each view's toolbar items.
            if #available(macOS 26.0, *) {
                ToolbarSpacer(.fixed, placement: .primaryAction)
            }
        }
        .overlay {
            if let initial = store.composer {
                ZStack(alignment: .top) {
                    // Clicking anywhere outside the composer closes it.
                    Color.black.opacity(0.35)
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { store.composer = nil }
                    NewTaskComposer(initial: initial) { store.composer = nil }
                        .shadow(radius: 30, y: 10)
                        .padding(.top, 90)
                }
                .transition(.opacity)
            }
        }
        // CC-12 links in descriptions and comments open in place.
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "controlcenter", url.host == "task", let id = Int(url.lastPathComponent) else {
                return .systemAction
            }
            store.open(id)
            return .handled
        })
    }

    private var statusFooter: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let error = store.lastError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }
            if !store.running.isEmpty {
                Label("\(store.running.count) agent\(store.running.count == 1 ? "" : "s") running", systemImage: "sparkles")
                    .font(.caption)
                    .foregroundStyle(.purple)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

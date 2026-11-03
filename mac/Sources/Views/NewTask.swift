import SwiftUI

/// What the composer starts with, taken from where it was opened (team in view, project board, calendar day…).
struct TaskDraft: Equatable {
    var title = ""
    var description = ""
    var status: TaskStatus = .new
    var priority: Priority = .none
    var kind: TaskKind = .human
    var teamId: Int?
    var project: String?
    var labels: [String] = []
    var scheduledOn: String?
    var due: String?
    var parentId: Int?

    var fields: [String: Any] {
        var out: [String: Any] = ["title": title.trimmingCharacters(in: .whitespacesAndNewlines),
                                  "status": status.rawValue, "kind": kind.rawValue, "priority": priority.rawValue,
                                  "labels": labels, "source": "app"]
        let description = description.trimmingCharacters(in: .whitespacesAndNewlines)
        if !description.isEmpty { out["description"] = description }
        if let teamId { out["team_id"] = teamId }
        if let project { out["project"] = project }
        if let scheduledOn { out["scheduled_on"] = scheduledOn }
        if let due { out["due"] = due }
        if let parentId { out["parent_id"] = parentId }
        return out
    }
}

/// Linear-style "New issue" composer: big title, Markdown description, a row of property chips.
struct NewTaskComposer: View {
    var store = BoardStore.shared
    let initial: TaskDraft
    let close: () -> Void

    @State private var draft = TaskDraft()
    @State private var createMore = false
    @State private var editingProject = false
    @State private var editingLabels = false
    @State private var files: [PendingFile] = []
    @FocusState private var titleFocused: Bool

    /// Grows with the text like a TextEditor would (the paste-aware view scrolls instead of sizing itself).
    private var descriptionHeight: CGFloat {
        let lines = draft.description.split(separator: "\n", omittingEmptySubsequences: false)
            .reduce(0) { $0 + max(1, Int(ceil(Double($1.count) / 90))) }
        return min(260, max(70, CGFloat(lines) * 18 + 4))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            VStack(alignment: .leading, spacing: 10) {
                TextField("Task title", text: $draft.title, axis: .vertical)
                    .font(.system(size: 20, weight: .semibold))
                    .textFieldStyle(.plain)
                    .lineLimit(1...3)
                    .focused($titleFocused)
                    .onSubmit(create)
                ZStack(alignment: .topLeading) {
                    if draft.description.isEmpty {
                        Text("Add description… (Markdown; paste screenshots or drop files)")
                            .font(.system(size: 14))
                            .foregroundStyle(.tertiary)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                    ComposerTextView(text: $draft.description, fontSize: 14) { files.append(contentsOf: $0) }
                        .frame(height: descriptionHeight)
                }
                PendingFilesStrip(images: $files)
            }
            .padding(.horizontal, 18)
            .padding(.top, 6)

            chips
                .padding(.horizontal, 16)
                .padding(.vertical, 12)

            Divider()
            footer
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
        .frame(width: 680)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.25)))
        .onAppear {
            draft = initial
            titleFocused = true
        }
        .onExitCommand(perform: close)
    }

    // MARK: Parts

    private var header: some View {
        HStack(spacing: 6) {
            let team = store.team(draft.teamId)
            HStack(spacing: 5) {
                TeamBadge(team: team, size: 16)
                Text(team?.name ?? "No team").font(.callout.weight(.medium))
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            if let parent = draft.parentId.flatMap(store.task) {
                Text(parent.key).font(.callout).foregroundStyle(.secondary)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
            Text(draft.parentId == nil ? "New task" : "New sub-task").font(.callout)
            Spacer()
            Button(action: close) { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
                .help("Close (Esc)")
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 6)
    }

    private var chips: some View {
        FlowLayout(spacing: 6) {
            Menu {
                ForEach([TaskStatus.new, .ready], id: \.self) { s in
                    Button { draft.status = s } label: { Label(s.label, systemImage: s == .new ? "circle.dashed" : "circle") }
                }
            } label: {
                Chip(icon: draft.status == .new ? "circle.dashed" : "circle", text: draft.status.label,
                     tint: draft.status.color, active: true)
            }
            .chipMenu()
            .help(draft.kind == .agent ? "Ready approves it: the runner starts it on its scheduled day." : "Status")

            Menu {
                ForEach(Priority.allCases, id: \.self) { p in Button(p.label) { draft.priority = p } }
            } label: {
                Chip(icon: "chart.bar.fill", text: draft.priority == .none ? "Priority" : draft.priority.label,
                     active: draft.priority != .none)
            }
            .chipMenu()

            Menu {
                ForEach(TaskKind.allCases, id: \.self) { k in
                    Button { draft.kind = k } label: { Label(k.label, systemImage: k.symbol) }
                }
            } label: {
                Chip(icon: draft.kind.symbol, text: draft.kind.label, tint: draft.kind == .agent ? .purple : nil, active: true)
            }
            .chipMenu()

            Menu {
                Button("No team") { draft.teamId = nil }
                ForEach(store.teams) { team in
                    Button { selectTeam(team.id) } label: { Label(team.name, systemImage: team.symbol) }
                }
            } label: {
                Chip(icon: store.team(draft.teamId)?.symbol ?? "building.2", text: store.team(draft.teamId)?.name ?? "Team",
                     tint: store.team(draft.teamId)?.tint, active: draft.teamId != nil)
            }
            .chipMenu()

            Button { editingProject = true } label: {
                Chip(icon: "cube", text: draft.project ?? "Project",
                     tint: draft.project.map(ProjectColor.of), active: draft.project != nil)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $editingProject, arrowEdge: .bottom) {
                ProjectPicker(selection: $draft.project, teamId: draft.teamId) { project in
                    // A project that already has a team brings it along.
                    if let teamId = project.flatMap(store.spec(for:))?.teamId { draft.teamId = teamId }
                    editingProject = false
                }
            }

            Button { editingLabels = true } label: {
                Chip(icon: "tag", text: draft.labels.isEmpty ? "Labels" : draft.labels.joined(separator: ", "),
                     active: !draft.labels.isEmpty)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $editingLabels, arrowEdge: .bottom) { LabelPicker(labels: $draft.labels) }

            DateChip(icon: "calendar", placeholder: "Scheduled", value: $draft.scheduledOn)
                .help("The day to do it. Agent tasks wait for it.")
            DateChip(icon: "flag", placeholder: "Due", value: $draft.due)
                .help("Deadline")
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            AttachFilesButton { files.append(contentsOf: $0) }
            if draft.kind == .agent {
                Text(draft.status == .ready
                     ? "The agent starts \(draft.scheduledOn.map { "on \(Day.title($0))" } ?? "right away")."
                     : "Stays in New until you approve it (Ready).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Toggle("Create more", isOn: $createMore)
                .toggleStyle(.switch)
                .controlSize(.mini)
                .font(.callout)
            Button(action: create) {
                Text(draft.parentId == nil ? "Create task" : "Create sub-task").padding(.horizontal, 4)
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func selectTeam(_ id: Int) {
        draft.teamId = id
        // Keep the project only if it belongs to that team (or to none).
        if let project = draft.project, let spec = store.spec(for: project), spec.teamId != nil, spec.teamId != id {
            draft.project = nil
        }
    }

    private func create() {
        guard !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        store.create(draft.fields, files: files, open: !createMore && draft.parentId == nil)
        files = []
        if createMore {
            draft.title = ""
            draft.description = ""
            titleFocused = true
        } else {
            close()
        }
    }
}

// MARK: Chips

private struct Chip: View {
    let icon: String
    let text: String
    var tint: Color?
    var active = false

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.system(size: 11)).foregroundStyle(tint ?? .secondary)
            Text(text).lineLimit(1).foregroundStyle(active ? .primary : .secondary)
        }
        .font(.callout)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(Color.secondary.opacity(active ? 0.14 : 0.07), in: Capsule())
        .overlay(Capsule().stroke(Color.secondary.opacity(0.18)))
        .fixedSize()
        .contentShape(Capsule())
    }
}

private extension View {
    func chipMenu() -> some View {
        menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
    }
}

private struct DateChip: View {
    let icon: String
    let placeholder: String
    @Binding var value: String?
    @State private var picking = false

    var body: some View {
        Menu {
            Button("Today") { value = Day.today }
            Button("Tomorrow") { value = Day.adding(1, to: Day.today) }
            Button("Next Monday") { value = Day.adding(7, to: Day.weekStart(Day.today)) }
            Button("Pick a date…") { picking = true }
            if value != nil { Divider(); Button("Clear") { value = nil } }
        } label: {
            Chip(icon: icon, text: value.map(Day.shortTitle) ?? placeholder, active: value != nil)
        }
        .chipMenu()
        .popover(isPresented: $picking, arrowEdge: .bottom) {
            DatePicker("", selection: Binding(get: { value.map(Day.date) ?? Date() },
                                              set: { value = Day.string($0); picking = false }),
                       displayedComponents: .date)
                .datePickerStyle(.graphical)
                .labelsHidden()
                .padding(10)
        }
    }
}

/// Search existing projects (current team first) or type a new name.
private struct ProjectPicker: View {
    var store = BoardStore.shared
    @Binding var selection: String?
    let teamId: Int?
    let picked: (String?) -> Void
    @State private var query = ""

    private var options: [String] {
        let names = Set(store.projectSpecs.map(\.name) + store.allTasks.compactMap(\.project))
        let inTeam: (String) -> Bool = { teamId == nil || store.spec(for: $0)?.teamId == teamId }
        let matches = names.filter { query.isEmpty || $0.localizedCaseInsensitiveContains(query) }
        return matches.sorted { (inTeam($0) ? 0 : 1, $0) < (inTeam($1) ? 0 : 1, $1) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Project…", text: $query)
                .textFieldStyle(.roundedBorder)
                .onSubmit { choose(options.first { $0.caseInsensitiveCompare(query) == .orderedSame } ?? query) }
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if selection != nil { row("No project", icon: "xmark.circle") { choose(nil) } }
                    ForEach(options, id: \.self) { name in
                        row(name, icon: selection == name ? "checkmark" : "cube", tint: ProjectColor.of(name)) { choose(name) }
                    }
                    let trimmed = query.trimmingCharacters(in: .whitespaces)
                    if !trimmed.isEmpty, !options.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
                        row("Create \u{201C}\(trimmed)\u{201D}", icon: "plus") { choose(trimmed) }
                    }
                }
            }
            .frame(maxHeight: 220)
        }
        .padding(10)
        .frame(width: 240)
    }

    private func row(_ title: String, icon: String, tint: Color = .secondary, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label { Text(title) } icon: { Image(systemName: icon).foregroundStyle(tint) }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 3)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func choose(_ name: String?) {
        let value = name?.trimmingCharacters(in: .whitespaces)
        selection = (value?.isEmpty ?? true) ? nil : value
        picked(selection)
    }
}

/// Toggle existing labels or add a new one.
private struct LabelPicker: View {
    var store = BoardStore.shared
    @Binding var labels: [String]
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Add or find label…", text: $query)
                .textFieldStyle(.roundedBorder)
                .onSubmit {
                    let l = query.trimmingCharacters(in: .whitespaces).lowercased()
                    if !l.isEmpty, !labels.contains(l) { labels.append(l) }
                    query = ""
                }
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    let all = Array(Set(store.allLabels + labels)).sorted()
                    ForEach(all.filter { query.isEmpty || $0.localizedCaseInsensitiveContains(query) }, id: \.self) { label in
                        Toggle(label, isOn: Binding(get: { labels.contains(label) }, set: { on in
                            if on { labels.append(label) } else { labels.removeAll { $0 == label } }
                        }))
                        .toggleStyle(.checkbox)
                    }
                }
            }
            .frame(maxHeight: 200)
        }
        .padding(10)
        .frame(width: 220)
    }
}

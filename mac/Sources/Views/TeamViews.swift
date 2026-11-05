import AppKit
import SwiftUI

/// Sidebar header: switch between All teams, each company and Personal.
struct TeamSwitcher: View {
    var store = BoardStore.shared
    @State private var addingTeam = false

    var body: some View {
        Menu {
            Button { select(nil) } label: { Label("All teams", systemImage: "square.grid.2x2") }
            Divider()
            ForEach(store.teams) { team in
                Button { select(team.id) } label: { Label(team.name, systemImage: team.symbol) }
            }
            Divider()
            if let team = store.currentTeam {
                Button("\(team.name) settings…") {
                    store.section = .team(team.id)
                    store.selectedTaskId = nil
                }
            }
            Button("New team…") { addingTeam = true }
        } label: {
            HStack(spacing: 8) {
                TeamBadge(team: store.currentTeam, size: 22)
                Text(store.currentTeam?.name ?? "All teams").font(.headline).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .popover(isPresented: $addingTeam, arrowEdge: .bottom) { NewTeamForm { addingTeam = false } }
    }

    private func select(_ id: Int?) {
        store.teamFilter = id
        if case .team = store.section { store.section = id.map(Section.team) ?? .today }
        store.selectedTaskId = nil
    }
}

/// Rounded square with the team's initial, or a grid for All teams.
struct TeamBadge: View {
    let team: Team?
    var size: CGFloat = 18

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.27)
            .fill(team?.tint ?? Color.secondary.opacity(0.5))
            .frame(width: size, height: size)
            .overlay {
                if let team {
                    Text(team.name.prefix(1).uppercased())
                        .font(.system(size: size * 0.55, weight: .bold))
                        .foregroundStyle(.white)
                } else {
                    Image(systemName: "square.grid.2x2.fill").font(.system(size: size * 0.5)).foregroundStyle(.white)
                }
            }
    }
}

struct NewTeamForm: View {
    var store = BoardStore.shared
    let done: () -> Void
    @State private var name = ""
    @State private var kind = "company"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("New team").font(.headline)
            TextField("Company name", text: $name)
                .textFieldStyle(.roundedBorder)
                .onSubmit(create)
            Picker("", selection: $kind) {
                Text("Company").tag("company")
                Text("Personal").tag("personal")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            HStack {
                Spacer()
                Button("Cancel", action: done)
                Button("Create", action: create)
                    .keyboardShortcut(.defaultAction)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(14)
        .frame(width: 280)
    }

    private func create() {
        store.addTeam(name: name, kind: kind)
        done()
    }
}

/// A team's specs: everything an agent should know before working on its tasks.
struct TeamSettingsView: View {
    let team: Team
    var store = BoardStore.shared

    @State private var name = ""
    @State private var workdir = ""
    @State private var github = ""
    @State private var baseBranch = ""
    @State private var linearTeams = ""
    @State private var linearReviewState = ""
    @State private var linearDoneState = ""
    @State private var linearAssignee = ""
    @State private var linearApprovers = ""
    @State private var linearPostProgress = false
    @State private var newProject = ""

    private var projects: [ProjectSpec] { store.projectSpecs.filter { $0.teamId == team.id } }
    private var unassigned: [ProjectSpec] { store.projectSpecs.filter { $0.teamId == nil } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                header
                group("Briefing for agents",
                      note: "Every agent working on a \(team.name) task reads this first: what the company does, rules, tone, people.") {
                    MarkdownEditor(value: team.context, placeholder: "Add a briefing…", minHeight: 200) { value in
                        store.updateTeam(team, ["context": value]) { $0.context = value }
                    }
                    .id(team.id)
                }
                group("GitHub", note: "The org (or user) this team's repos live under.") {
                    HStack {
                        TextField("https://github.com/…", text: $github)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit(saveGithub)
                        if let url = team.github.flatMap(URL.init(string:)) {
                            Link("Open", destination: url)
                        }
                    }
                }
                group("Other repositories", note: "Only for repos outside the working folder (those below are found automatically). Agents are told where each is checked out."){
                    RepoListEditor(repos: team.repos) { repos in
                        store.updateTeam(team, ["repos": repos.map(\.json)]) { $0.repos = repos }
                    }
                }
                group("Base branch", note: "Agent worktrees start from the latest origin/<branch> and PRs target it. Leave empty to use each repo's GitHub default; set a repo's own below to override.") {
                    TextField("GitHub default", text: $baseBranch)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 220)
                        .onSubmit {
                            let value = baseBranch.trimmingCharacters(in: .whitespaces)
                            guard value != (team.baseBranch ?? "") else { return }
                            store.updateTeam(team, ["base_branch": value.isEmpty ? NSNull() : value]) { $0.baseBranch = value.isEmpty ? nil : value }
                        }
                }
                foundRepos
                linearSection
                group("Working folder", note: "Where this team's files live on this Mac.") {
                    HStack {
                        TextField("~/Developer/projects/…", text: $workdir)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit(saveWorkdir)
                        Button("Choose…") {
                            if let url = FolderPicker.choose() { workdir = FolderPicker.tildePath(url); saveWorkdir() }
                        }
                    }
                }
                projectsSection
                group("Webhooks",
                      note: "Tell other apps when tasks, reviews and approvals change. Each webhook has its own signing secret and can follow the whole team or one project. A failed delivery is retried for about two hours, then the webhook pauses and tells you in the inbox.") {
                    WebhooksSection(team: team, projects: projects)
                }
            }
            .padding(.horizontal, 40)
            .padding(.vertical, 28)
            .frame(maxWidth: 860, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("\(team.name) settings")
        .onAppear(perform: load)
        .onChange(of: team.id) { _, _ in load() }
    }

    private func load() {
        name = team.name
        workdir = team.workdir ?? ""
        github = team.github ?? ""
        baseBranch = team.baseBranch ?? ""
        linearTeams = (team.linearTeams ?? []).joined(separator: ", ")
        linearReviewState = team.linearReviewState ?? ""
        linearDoneState = team.linearDoneState ?? ""
        linearAssignee = team.linearAssignee ?? ""
        linearApprovers = (team.linearApprovers ?? []).joined(separator: ", ")
        linearPostProgress = team.linearPostProgress ?? false
    }

    private var linearSection: some View {
        group("Linear", note: "Issues from these Linear teams that are delegated to Control Center become agent tasks here. An agent starts straight away if an approver delegated it; anyone else's waits as New until you approve it. Progress goes back to the issue. Needs the Linear app set up on the runner (see README).") {
            VStack(alignment: .leading, spacing: 8) {
                linearField("Linear teams", "Team keys, e.g. ENG, OPS", $linearTeams, saveLinearTeams)
                linearField("Approvers", "Linear emails whose delegations start work. Empty: all wait as New", $linearApprovers, saveLinearApprovers)
                linearField("Review status", "A started status with “review” in its name", $linearReviewState) {
                    saveLinear("linear_review_state", linearReviewState) { $0.linearReviewState = $1 }
                }
                linearField("Done status", "Never mark issues done", $linearDoneState) {
                    saveLinear("linear_done_state", linearDoneState) { $0.linearDoneState = $1 }
                }
                linearField("Also show issues assigned to", "Off, or an email: read-only tasks on Today", $linearAssignee) {
                    saveLinear("linear_assignee", linearAssignee) { $0.linearAssignee = $1 }
                }
                Toggle("Also post progress logs to the issue", isOn: $linearPostProgress)
                    .onChange(of: linearPostProgress) { _, on in
                        guard on != (team.linearPostProgress ?? false) else { return }
                        store.updateTeam(team, ["linear_post_progress": on]) { $0.linearPostProgress = on }
                    }
            }
        }
    }

    private func linearField(_ label: String, _ placeholder: String, _ text: Binding<String>, _ save: @escaping () -> Void) -> some View {
        HStack {
            Text(label).frame(width: 190, alignment: .leading)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .onSubmit(save)
        }
    }

    private func saveLinearTeams() {
        let keys = linearTeams
            .split(whereSeparator: { $0 == "," || $0.isWhitespace })
            .map { $0.uppercased() }
        linearTeams = keys.joined(separator: ", ")
        guard keys != (team.linearTeams ?? []) else { return }
        store.updateTeam(team, ["linear_teams": keys]) { $0.linearTeams = keys }
    }

    private func saveLinearApprovers() {
        let emails = linearApprovers
            .split(whereSeparator: { $0 == "," || $0.isWhitespace })
            .map { $0.lowercased() }
        linearApprovers = emails.joined(separator: ", ")
        guard emails != (team.linearApprovers ?? []) else { return }
        store.updateTeam(team, ["linear_approvers": emails]) { $0.linearApprovers = emails }
    }

    private func saveLinear(_ column: String, _ text: String, _ apply: @escaping (inout Team, String?) -> Void) {
        let value = text.trimmingCharacters(in: .whitespaces)
        store.updateTeam(team, [column: value.isEmpty ? NSNull() : value]) { apply(&$0, value.isEmpty ? nil : value) }
    }

    private var header: some View {
        HStack(spacing: 12) {
            TeamBadge(team: team, size: 40)
            VStack(alignment: .leading, spacing: 4) {
                TextField("Team name", text: $name)
                    .font(.system(size: 24, weight: .semibold))
                    .textFieldStyle(.plain)
                    .onSubmit {
                        let n = name.trimmingCharacters(in: .whitespaces)
                        if !n.isEmpty, n != team.name { store.updateTeam(team, ["name": n]) { $0.name = n } }
                    }
                HStack(spacing: 10) {
                    Picker("", selection: Binding(get: { team.kind }, set: { v in
                        store.updateTeam(team, ["kind": v]) { $0.kind = v }
                    })) {
                        Text("Company").tag("company")
                        Text("Personal").tag("personal")
                    }
                    .labelsHidden()
                    .fixedSize()
                    ColorPicker("", selection: Binding(get: { team.tint }, set: { color in
                        guard let hex = color.hex, hex != team.color else { return }
                        store.updateTeam(team, ["color": hex]) { $0.color = hex }
                    }), supportsOpacity: false)
                    .labelsHidden()
                    Text("Claude refers to this team as \u{201C}\(team.key)\u{201D}.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    @ViewBuilder private var foundRepos: some View {
        let repos = store.localRepos.filter { $0.teamId == team.id }
        group("Found on this Mac",
              note: "Every git repo in the working folder, refreshed by the runner every 10 minutes. Claude picks a task's repo from this list. Add nicknames people actually use (e.g. CareerSuite) so it matches them.") {
            if repos.isEmpty {
                Text(team.workdir == nil ? "Set a working folder below." : "None yet: the runner scans within 10 minutes.")
                    .font(.callout)
                    .foregroundStyle(.tertiary)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(repos) { repo in
                    LocalRepoRow(repo: repo)
                    if repo.id != repos.last?.id { Divider() }
                }
            }
        }
    }

    private var projectsSection: some View {
        group("Projects", note: "Tasks in these projects belong to \(team.name). Each project can have its own spec and repos.") {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(projects) { ProjectSpecCard(spec: $0, team: team) }
                HStack(spacing: 8) {
                    Image(systemName: "plus").foregroundStyle(.tertiary)
                    TextField("Add project", text: $newProject)
                        .textFieldStyle(.plain)
                        .onSubmit {
                            store.addProject(newProject, teamId: team.id)
                            newProject = ""
                        }
                    if !unassigned.isEmpty {
                        Menu("Add existing") {
                            ForEach(unassigned) { p in Button(p.name) { store.addProject(p.name, teamId: team.id) } }
                        }
                        .fixedSize()
                    }
                }
            }
        }
    }

    private func saveGithub() {
        let value = github.trimmingCharacters(in: .whitespaces)
        guard value != (team.github ?? "") else { return }
        store.updateTeam(team, ["github": value.isEmpty ? NSNull() : value]) { $0.github = value.isEmpty ? nil : value }
    }

    private func saveWorkdir() {
        let value = workdir.trimmingCharacters(in: .whitespaces)
        guard value != (team.workdir ?? "") else { return }
        store.updateTeam(team, ["workdir": value.isEmpty ? NSNull() : value]) { $0.workdir = value.isEmpty ? nil : value }
    }

    private func group<Content: View>(_ title: String, note: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            Text(note).font(.callout).foregroundStyle(.secondary)
            content().padding(.top, 2)
        }
    }
}

struct ProjectSpecCard: View {
    let spec: ProjectSpec
    let team: Team
    var store = BoardStore.shared
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                    Image(systemName: "chevron.right")
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .frame(width: 14)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                Circle().fill(ProjectColor.of(spec.name)).frame(width: 9, height: 9)
                Text(spec.name).fontWeight(.medium)
                let open = store.allTasks.filter { $0.project == spec.name && $0.status.isOpen }.count
                Text("\(open) open").font(.caption).foregroundStyle(.secondary)
                if !spec.repos.isEmpty {
                    Label("\(spec.repos.count)", systemImage: "chevron.left.forwardslash.chevron.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Open board") {
                    store.section = .project(spec.name)
                    store.selectedTaskId = nil
                }
                .buttonStyle(.borderless)
                .font(.caption)
                Menu {
                    ForEach(store.teams.filter { $0.id != team.id }) { other in
                        Button("Move to \(other.name)") {
                            store.updateProject(spec, ["team_id": other.id]) { $0.teamId = other.id }
                        }
                    }
                    Divider()
                    Button("Remove from \(team.name)") {
                        store.updateProject(spec, ["team_id": NSNull()]) { $0.teamId = nil }
                    }
                } label: { Image(systemName: "ellipsis") }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
            }
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.snappy) { expanded.toggle() } }

            if expanded {
                VStack(alignment: .leading, spacing: 12) {
                    MarkdownEditor(value: spec.description, placeholder: "Add a project spec: goals, rules, where things live…") { value in
                        store.updateProject(spec, ["description": value]) { $0.description = value }
                    }
                    RepoListEditor(repos: spec.repos) { repos in
                        store.updateProject(spec, ["repos": repos.map(\.json)]) { $0.repos = repos }
                    }
                    Picker("Agents' PRs", selection: Binding(
                        get: { spec.prReview ?? "owner" },
                        set: { value in store.updateProject(spec, ["pr_review": value]) { $0.prReview = value } }
                    )) {
                        Text("I review and merge").tag("owner")
                        Text("A review agent merges when CI is green").tag("agent")
                    }
                    .fixedSize()
                    .help("With a review agent, a fresh session takes each PR to merged: it waits for the repo's AI review pipeline where there is one (or runs /code-review where there isn't), fixes what's left and merges once CI passes. It asks you only when a finding needs your call.")
                }
                .padding(.leading, 22)
            } else if let description = spec.description, !description.isEmpty {
                Text(description.replacingOccurrences(of: "\n", with: " "))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.leading, 22)
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }
}

extension Color {
    /// "#RRGGBB" in sRGB.
    var hex: String? {
        guard let c = NSColor(self).usingColorSpace(.sRGB) else { return nil }
        return String(format: "#%02X%02X%02X", Int(round(c.redComponent * 255)), Int(round(c.greenComponent * 255)),
                      Int(round(c.blueComponent * 255)))
    }
}

struct LocalRepoRow: View {
    let repo: LocalRepo
    var store = BoardStore.shared
    @State private var aliases = ""
    @State private var branch = ""

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(repo.name).fontWeight(.medium)
                    if repo.hidden { Text("hidden").font(.caption).foregroundStyle(.tertiary) }
                    if let url = repo.githubUrl.flatMap(URL.init(string:)) {
                        Link(destination: url) { Image(systemName: "arrow.up.right.square") }.help(url.absoluteString)
                    }
                }
                if let description = repo.description {
                    Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { store.setHidden(repo, !repo.hidden) } label: {
                Image(systemName: repo.hidden ? "eye.slash" : "eye")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .help(repo.hidden ? "Hidden: never matched or offered. Click to show." : "Hide from matching (e.g. a stale copy)")
            TextField("Base branch", text: $branch)
                .textFieldStyle(.roundedBorder)
                .font(.callout)
                .frame(width: 110)
                .help("Overrides the team's base branch for this repo")
                .onSubmit {
                    let value = branch.trimmingCharacters(in: .whitespaces)
                    let next: String? = value.isEmpty ? nil : value
                    if next != repo.baseBranch { store.setBaseBranch(repo, next) }
                }
            TextField("Nicknames, comma separated", text: $aliases)
                .textFieldStyle(.roundedBorder)
                .font(.callout)
                .frame(width: 230)
                .onSubmit(save)
        }
        .padding(.vertical, 6)
        .opacity(repo.hidden ? 0.5 : 1)
        .onAppear {
            aliases = repo.aliases.joined(separator: ", ")
            branch = repo.baseBranch ?? ""
        }
    }

    private func save() {
        let list = aliases.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if list != repo.aliases { store.setAliases(repo, list) }
    }
}

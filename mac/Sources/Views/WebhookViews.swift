import AppKit
import SwiftUI

/// A team's webhooks in its settings. The sender is the Worker's cron, so a test ping goes out within a
/// minute; this keeps polling while it's on screen so the result shows up by itself.
struct WebhooksSection: View {
    let team: Team
    let projects: [ProjectSpec]
    var store = BoardStore.shared
    @State private var adding = false
    @State private var newSecret: String?

    private var hooks: [Webhook] { store.webhooks.filter { $0.teamId == team.id } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let newSecret { SecretBanner(secret: newSecret) { self.newSecret = nil } }
            ForEach(hooks) { WebhookRow(hook: $0) }
            if adding {
                NewWebhookForm(team: team, projects: projects, cancel: { adding = false }) { secret in
                    adding = false
                    newSecret = secret
                }
            } else {
                Button { adding = true } label: { Label("Add webhook", systemImage: "plus") }
                    .buttonStyle(.borderless)
            }
        }
        .task(id: team.id) {
            while !Task.isCancelled {
                await store.loadWebhooks(team: team.id)
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }
}

/// Shown once, straight after creating a webhook: the secret can't be read back later.
private struct SecretBanner: View {
    let secret: String
    let dismiss: () -> Void
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Copy the signing secret now. It won't be shown again.", systemImage: "key.fill").fontWeight(.medium)
            Text(secret)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
            HStack {
                Button(copied ? "Copied" : "Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(secret, forType: .string)
                    copied = true
                }
                Button("Done", action: dismiss)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct WebhookRow: View {
    let hook: Webhook
    var store = BoardStore.shared
    @State private var confirmingDelete = false

    private var eventLabels: String {
        Webhook.events.filter { hook.events.contains($0.id) }.map(\.label).joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(dot).frame(width: 8, height: 8)
                Text(hook.url).fontWeight(.medium).lineLimit(1).truncationMode(.middle)
                Spacer()
                Button("Send test") { store.testWebhook(hook) }
                    .help("Sends a signed ping within a minute, even while paused. A failed ping doesn't count against the webhook.")
                Button(hook.active ? "Pause" : "Resume") { store.setWebhookActive(hook, !hook.active) }
                    .help(hook.active ? "Events keep queueing while it's paused." : "Sends everything that queued or failed while it was paused.")
                Button { confirmingDelete = true } label: { Image(systemName: "trash") }
                    .help("Delete this webhook")
                    .confirmationDialog("Delete this webhook?", isPresented: $confirmingDelete) {
                        Button("Delete", role: .destructive) { store.deleteWebhook(hook) }
                    } message: {
                        Text("Its secret and anything still waiting to be sent are deleted too.")
                    }
            }
            Text("\(hook.project ?? "Whole team") · \(hook.scope == "all" ? "every task" : "tasks from other apps") · \(eventLabels)")
                .font(.caption)
                .foregroundStyle(.secondary)
            deliveryStatus.font(.caption)
        }
        .buttonStyle(.borderless)
        .padding(12)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private var dot: Color {
        if !hook.active { return .orange }
        if hook.lastDeliveryOk == false { return .red }
        return hook.lastDeliveryOk == true ? .green : .secondary
    }

    @ViewBuilder private var deliveryStatus: some View {
        HStack(spacing: 4) {
            if !hook.active {
                Text("Paused: \(hook.pausedReason ?? "no reason given").").foregroundStyle(.orange)
            }
            if let at = hook.lastDeliveryAt, let ok = hook.lastDeliveryOk {
                if ok {
                    Text("Last delivered").foregroundStyle(.secondary)
                } else {
                    Text("Last delivery failed (\(hook.lastDeliveryError ?? "unknown error"))").foregroundStyle(.red)
                }
                RelativeTime(timestamp: at).foregroundStyle(.tertiary)
            } else if hook.active {
                Text("Nothing sent yet.").foregroundStyle(.tertiary)
            }
            if hook.pending > 0 {
                Text("· \(hook.pending) waiting").foregroundStyle(.secondary)
            }
        }
    }
}

private struct NewWebhookForm: View {
    let team: Team
    let projects: [ProjectSpec]
    let cancel: () -> Void
    let created: (String) -> Void
    var store = BoardStore.shared

    @State private var url = ""
    @State private var project: Int?
    @State private var scope = "external"
    @State private var events = Set(Webhook.events.filter { !$0.optIn }.map(\.id))
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("https://…", text: $url).textFieldStyle(.roundedBorder)
            HStack(spacing: 16) {
                Picker("Follows", selection: $project) {
                    Text("Whole team").tag(Int?.none)
                    ForEach(projects) { Text($0.name).tag(Int?.some($0.id)) }
                }
                .fixedSize()
                Picker("Tasks", selection: $scope) {
                    Text("From other apps").tag("external")
                    Text("Every task").tag("all")
                }
                .fixedSize()
            }
            HStack(spacing: 12) {
                ForEach(Webhook.events, id: \.id) { event in
                    Toggle(event.label, isOn: Binding(
                        get: { events.contains(event.id) },
                        set: { on in if on { events.insert(event.id) } else { events.remove(event.id) } }
                    ))
                    .toggleStyle(.checkbox)
                    .help(event.optIn ? "Off by default: this one is noisy." : "")
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack {
                Button("Add webhook", action: add)
                    .disabled(saving || events.isEmpty || url.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("Cancel", action: cancel)
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func add() {
        saving = true
        error = nil
        Task {
            defer { saving = false }
            do {
                let secret = try await store.addWebhook(
                    team: team.id,
                    url: url.trimmingCharacters(in: .whitespaces),
                    project: project,
                    events: Webhook.events.map(\.id).filter(events.contains),
                    scope: scope
                )
                created(secret)
            } catch BoardAPI.APIError.http(_, let body) where body.contains("23514") {
                error = "The URL must be https, with no password in it."
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

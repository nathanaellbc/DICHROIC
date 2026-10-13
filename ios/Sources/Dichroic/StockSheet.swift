import SwiftUI

/// Film & Paper picker (web StockBrowser in its sheet): picks preview at once,
/// Cancel restores the stocks from when it opened, Swap compares with the
/// previous choice.
struct StockSheet: View {
    @Bindable var model: EditorModel
    @Environment(\.dismiss) private var dismiss
    @State private var tab = "film"
    @State private var query = ""
    @State private var before: JSON = [:]
    @State private var swap: JSON = [:]

    private static func pick(_ p: JSON) -> JSON {
        var out: JSON = [:]
        for key in ["film", "filmEnabled", "paper", "process"] { out[key] = p[key] ?? NSNull() }
        return out
    }

    var body: some View {
        let p = model.params, s = Stocks(catalog: model.catalog, params: p)
        let current = Self.pick(p)
        NavigationStack {
            List {
                Section {
                    Picker("List", selection: $tab) {
                        Text("Film").tag("film")
                        Text("Paper").tag("paper")
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets())

                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Process").font(.system(size: 15, weight: .semibold))
                            Text(!s.filmEnabled ? "Neutral negative · controls active" : s.scan ? "The film itself, no paper" : "Film printed onto paper")
                                .font(.system(size: 13)).foregroundStyle(Color.secondaryText)
                        }
                        Spacer()
                        Picker("Process", selection: Binding(get: { p.string("process") == "scanNegative" ? 1 : 0 },
                                                             set: { model.edit("choice", "process", $0 == 0 ? "printSimulation" : "scanNegative") })) {
                            Text("Print").tag(0)
                            Text("Scan").tag(1)
                        }
                        .pickerStyle(.segmented).frame(width: 150)
                    }
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 8, leading: 4, bottom: 0, trailing: 4))

                    if !swap.isEmpty, !jsonEqual(swap, current) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Previous").font(.system(size: 13)).foregroundStyle(Color.secondaryText)
                                Text(Stocks(catalog: model.catalog, params: swap).recipe).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                            }
                            Spacer()
                            CapsuleButton(title: "Swap") {
                                let next = swap
                                swap = current
                                model.edit("fields", "stocks", next)
                            }
                            .accessibilityLabel("Swap with previous stocks, \(Stocks(catalog: model.catalog, params: swap).recipe)")
                        }
                        .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 8, leading: 4, bottom: 0, trailing: 4))
                    }
                }
                stockList(p, s)
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
            .navigationTitle("Film & Paper")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.edit("fields", "stocks", before); dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.fontWeight(.semibold) }
            }
        }
        .onAppear {
            if before.isEmpty { before = Self.pick(model.params); swap = before }
        }
    }

    @ViewBuilder private func stockList(_ p: JSON, _ s: Stocks) -> some View {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let chosen = p.string(tab)
        let sections: [(JSON, [JSON])] = model.catalog.list("\(tab)Sections").compactMap { section in
            let stocks = section.list("stocks").filter { stock in
                q.isEmpty || "\(stock.string("name") ?? "") \(stock.string("detail") ?? "")".lowercased().contains(q)
            }
            return stocks.isEmpty ? nil : (section, stocks)
        }
        if sections.isEmpty {
            Text("No stocks match “\(query)”.").foregroundStyle(Color.secondaryText).frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
        }
        if q.isEmpty {
            Section {
                if tab == "film" {
                    row(name: "Off", detail: "Neutral negative · controls active", selected: !s.filmEnabled, disabled: false, locked: false) {
                        model.edit("film", "film", "off")
                    }
                }
            } footer: {
                Text(stockHint(tab, filmEnabled: s.filmEnabled, scan: s.scan))
            }
        }
        ForEach(sections.indices, id: \.self) { i in
            let section = sections[i].0, stocks = sections[i].1
            let title = section.string("title") ?? "", locked = section.bool("locked")
            Section {
                ForEach(stocks.indices, id: \.self) { j in
                    let stock = stocks[j], id = stock.string("id") ?? ""
                    let paperOff = tab == "paper" && (s.scan || !s.filmEnabled || s.isSlide(p.string("film"))) && !Stocks.isPrintLut(id)
                    let selected = !locked && id == chosen && !paperOff && (tab != "film" || s.filmEnabled)
                    // Brand dropped under the Kodak and Fujifilm headers.
                    let name = (tab == "film" && locked) || !(title == "Kodak" || title == "Fujifilm")
                        ? stock.string("name") ?? id : stock.string("short") ?? id
                    row(name: name, detail: stock.string("detail") ?? "", selected: selected, disabled: locked || paperOff, locked: locked) {
                        model.edit(tab, tab, id)
                    }
                }
            } header: {
                Text(title)
            } footer: {
                if let footer = section.string("footer") { Text(footer) }
            }
        }
    }

    private func row(name: String, detail: String, selected: Bool, disabled: Bool, locked: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).foregroundStyle(Color.primary)
                    Text(detail).font(.system(size: 13)).foregroundStyle(Color.secondaryText)
                }
                Spacer()
                if locked { Image(systemName: "lock").foregroundStyle(Color.secondaryText) }
                else if selected { Image(systemName: "checkmark").font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.signal) }
            }
            .frame(minHeight: 44)
        }
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

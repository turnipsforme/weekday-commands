import {
  App,
  Command,
  Modal,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  TextComponent,
  moment,
  type SettingDefinitionItem,
} from "obsidian";

interface WeekdayCommandsSettings {
  integrateWithJournalView: boolean;
  dailyNotesFolder: string;
}

interface NativeDailyNoteSettings {
  format: string;
  folder: string;
  template: string;
}

interface NaturalLanguageDatesPlugin {
  parseDate: (date: string) =>
    | {
        date?: Date;
        moment?: moment.Moment;
      }
    | null
    | undefined;
}

interface JournalViewPlugin {
  activateView: (forceNewTab?: boolean, date?: moment.Moment, focusAtEnd?: boolean) => Promise<void>;
}

const DEFAULT_SETTINGS: WeekdayCommandsSettings = {
  integrateWithJournalView: false,
  dailyNotesFolder: "",
};

function parseSettings(value: unknown): WeekdayCommandsSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_SETTINGS };
  }

  const stored = value as Record<string, unknown>;
  return {
    integrateWithJournalView: typeof stored.integrateWithJournalView === "boolean"
      ? stored.integrateWithJournalView
      : DEFAULT_SETTINGS.integrateWithJournalView,
    dailyNotesFolder: typeof stored.dailyNotesFolder === "string"
      ? stored.dailyNotesFolder
      : DEFAULT_SETTINGS.dailyNotesFolder,
  };
}

const obsidianMoment = moment as unknown as {
  (): moment.Moment;
  (input: string | Date): moment.Moment;
  (input: string, format: string, strict: boolean): moment.Moment;
  (input: string, format: readonly string[], strict: boolean): moment.Moment;
};

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const DATE_INPUT_FORMATS = [
  "YYYY-MM-DD",
  "YYYY/MM/DD",
  "YYYY.MM.DD",
  "MMMM D, YYYY",
  "MMMM Do, YYYY",
  "MMM D, YYYY",
  "MMM Do, YYYY",
  "D MMMM YYYY",
  "Do MMMM YYYY",
  "D MMM YYYY",
  "Do MMM YYYY",
  "M/D/YYYY",
  "MM/DD/YYYY",
  "D/M/YYYY",
  "DD/MM/YYYY",
  "MMMM D",
  "MMMM Do",
  "MMM D",
  "MMM Do",
  "D MMMM",
  "Do MMMM",
  "D MMM",
  "Do MMM",
] as const;

export default class WeekdayCommandsPlugin extends Plugin {
  settings!: WeekdayCommandsSettings;
  private pendingCreations = new Map<string, Promise<TFile>>();
  private settingsSave: Promise<void> = Promise.resolve();
  private dateModal?: NaturalLanguageDateModal;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "open-daily-note-by-date",
      name: "Go to daily note by date",
      callback: () => {
        this.dateModal?.close();
        this.dateModal = new NaturalLanguageDateModal(this.app, this);
        this.dateModal.open();
      },
    });

    for (const [targetDay, label] of WEEKDAYS.entries()) {
      this.addCommand(this.createWeekdayCommand(targetDay, label));
    }

    this.addSettingTab(new WeekdayCommandsSettingTab(this.app, this));
    this.register(() => this.dateModal?.close());
  }

  async loadSettings(): Promise<void> {
    const stored: unknown = await this.loadData();
    this.settings = parseSettings(stored);
  }

  saveSettings(): Promise<void> {
    const settings = { ...this.settings };
    this.settingsSave = this.settingsSave
      .then(() => this.saveData(settings))
      .catch((error: unknown) => {
        console.error("Weekday Commands: failed to save settings", error);
        new Notice("Could not save weekday commands settings. Please try again.");
      });
    return this.settingsSave;
  }

  private createWeekdayCommand(targetDay: number, label: string): Command {
    return {
      id: `open-next-${label.toLowerCase()}-daily-note`,
      name: `Go to next ${label}`,
      callback: async () => {
        await this.openNextWeekdayNote(targetDay);
      },
    };
  }

  private async openNextWeekdayNote(targetDay: number): Promise<void> {
    const nextDate = this.getNextWeekday(targetDay);
    await this.openDailyNote(nextDate);
  }

  async openDailyNoteFromInput(input: string): Promise<boolean> {
    const date = this.parseNaturalDate(input);
    if (!date?.isValid() || !Number.isFinite(date.valueOf())) {
      new Notice(`Could not understand date: ${input}`);
      return false;
    }

    return this.openDailyNote(date);
  }

  async openRecentDailyNote(file: TFile): Promise<boolean> {
    try {
      if (this.app.vault.getAbstractFileByPath(file.path) !== file) {
        throw new Error("This note was moved or deleted. Reopen the date picker to refresh the list.");
      }
      await this.openFile(file);
      return true;
    } catch (error) {
      this.reportOpenError(error);
      return false;
    }
  }

  private reportOpenError(error: unknown): void {
    console.error("Weekday Commands: failed to open daily note", error);
    new Notice("Could not open the daily note. Check the daily notes folder and try again.");
  }

  getRecentDailyNotes(limit = 3): TFile[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];

    const settings = this.getEffectiveDailyNoteSettings();
    const folder = settings.folder
      ? this.app.vault.getAbstractFileByPath(settings.folder)
      : this.app.vault.getRoot();
    if (!(folder instanceof TFolder)) return [];

    const today = obsidianMoment().startOf("day");
    const excludedPaths = new Set([-1, 0, 1].map((offset) =>
      this.buildNotePath(today.clone().add(offset, "day").format(settings.format), settings.folder)
    ));
    const recent: TFile[] = [];
    const folders = [folder];
    const hasDateFolders = settings.format.includes("/");
    while (folders.length > 0) {
      const current = folders.pop()!;
      for (const child of current.children) {
        if (child instanceof TFolder) {
          if (hasDateFolders) folders.push(child);
          continue;
        }
        if (!(child instanceof TFile) || child.extension !== "md" || excludedPaths.has(child.path)) continue;
        if (recent.length === limit && child.stat.mtime <= recent[recent.length - 1].stat.mtime) continue;
        if (!this.getDateForDailyNoteFile(child, settings)) continue;

        const index = recent.findIndex((file) => child.stat.mtime > file.stat.mtime);
        recent.splice(index === -1 ? recent.length : index, 0, child);
        if (recent.length > limit) recent.pop();
      }
    }
    return recent;
  }

  getDailyNoteLabel(file: TFile): string {
    return this.getDateForDailyNoteFile(file)?.format("ddd, D MMM YYYY") ?? file.basename;
  }

  private async openDailyNote(date: moment.Moment): Promise<boolean> {
    try {
      const settings = this.getEffectiveDailyNoteSettings();
      const filePath = this.buildNotePath(date.format(settings.format), settings.folder);
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      let file: TFile;
      if (existing instanceof TFile) {
        file = existing;
      } else {
        let pending = this.pendingCreations.get(filePath);
        if (!pending) {
          pending = this.createDailyNote(filePath, date, settings);
          this.pendingCreations.set(filePath, pending);
        }
        try {
          file = await pending;
        } finally {
          if (this.pendingCreations.get(filePath) === pending) this.pendingCreations.delete(filePath);
        }
      }
      await this.openFile(file, date);
      return true;
    } catch (error) {
      this.reportOpenError(error);
      return false;
    }
  }

  private async createDailyNote(
    filePath: string,
    date: moment.Moment,
    settings: NativeDailyNoteSettings,
  ): Promise<TFile> {
    const contents = await this.renderDailyNoteTemplate(date, settings);
    const lastSlash = filePath.lastIndexOf("/");
    await this.ensureFolderExists(lastSlash === -1 ? "" : filePath.slice(0, lastSlash));
    // Another plugin or vault sync may create the note while the template is loading.
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) return existing;
    try {
      return await this.app.vault.create(filePath, contents);
    } catch (error) {
      const created = this.app.vault.getAbstractFileByPath(filePath);
      if (created instanceof TFile) return created;
      throw error;
    }
  }

  private async renderDailyNoteTemplate(
    date: moment.Moment,
    dailyNoteSettings: NativeDailyNoteSettings
  ): Promise<string> {
    const templateContents = await this.getTemplateContents(dailyNoteSettings.template);
    const filename = date.format(dailyNoteSettings.format);

    return templateContents
      .replace(/{{\s*date\s*}}/gi, filename)
      .replace(/{{\s*time\s*}}/gi, obsidianMoment().format("HH:mm"))
      .replace(/{{\s*title\s*}}/gi, filename)
      .replace(
        /{{\s*(date|time)\s*(([+-]\d+)([yqmwdhs]))?\s*(:.+?)?}}/gi,
        (
          _match: string,
          _timeOrDate: string,
          calc: string | undefined,
          timeDelta: string | undefined,
          unit: string | undefined,
          momentFormat: string | undefined,
        ) => {
          const now = obsidianMoment();
          const currentDate = date.clone().set({
            hour: now.get("hour"),
            minute: now.get("minute"),
            second: now.get("second"),
          });

          if (calc && timeDelta && unit) {
            currentDate.add(parseInt(timeDelta, 10), unit as moment.unitOfTime.DurationConstructor);
          }

          if (momentFormat) {
            return currentDate.format(momentFormat.substring(1).trim());
          }

          return currentDate.format(dailyNoteSettings.format);
        }
      )
      .replace(/{{\s*yesterday\s*}}/gi, date.clone().subtract(1, "day").format(dailyNoteSettings.format))
      .replace(/{{\s*tomorrow\s*}}/gi, date.clone().add(1, "day").format(dailyNoteSettings.format));
  }

  private async getTemplateContents(template: string): Promise<string> {
    if (!template) {
      return "";
    }

    const templatePath = normalizePath(template);
    const templateFile = this.app.metadataCache.getFirstLinkpathDest(templatePath, "");
    if (!(templateFile instanceof TFile)) {
      new Notice(`Daily note template not found: ${template}`);
      return "";
    }

    return this.app.vault.cachedRead(templateFile);
  }

  private async openFile(file: TFile, date?: moment.Moment): Promise<void> {
    if (this.settings.integrateWithJournalView) {
      const targetDate = date ?? this.getDateForDailyNoteFile(file);
      if (targetDate && (await this.openInJournalView(targetDate))) {
        return;
      }
    }

    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private getDateForDailyNoteFile(
    file: TFile,
    settings = this.getEffectiveDailyNoteSettings(),
  ): moment.Moment | null {
    const prefix = settings.folder ? `${settings.folder}/` : "";
    if (!file.path.startsWith(prefix)) return null;
    const name = file.path.slice(prefix.length, -3);
    const date = obsidianMoment(name, settings.format, true);
    return date.isValid() && date.format(settings.format) === name ? date.startOf("day") : null;
  }

  private async openInJournalView(date: moment.Moment): Promise<boolean> {
    const pluginManager = (this.app as App & { plugins?: { getPlugin?: (id: string) => unknown } }).plugins;
    const journalViewPlugin = pluginManager?.getPlugin?.("journal-view") as JournalViewPlugin | undefined;
    if (typeof journalViewPlugin?.activateView !== "function") {
      new Notice("Journal view is not enabled. Opening the daily note in a tab instead.");
      return false;
    }

    try {
      await journalViewPlugin.activateView(false, date, true);
      return true;
    } catch (error) {
      console.error("Weekday Commands: failed to open Journal View", error);
      new Notice("Could not open journal view. Opening the daily note in a tab instead.");
      return false;
    }
  }

  private getNextWeekday(targetDay: number) {
    const today = obsidianMoment().startOf("day");
    const delta = (targetDay - today.day() + 7) % 7 || 7;
    return today.clone().add(delta, "days");
  }

  private parseNaturalDate(input: string): moment.Moment | null {
    const query = input.trim().toLowerCase().replace(/\s+/g, " ");
    if (!query) {
      return null;
    }

    const today = obsidianMoment().startOf("day");
    const weekdayDate = this.parseWeekdayDate(query, today);
    if (weekdayDate) {
      return weekdayDate;
    }

    const naturalLanguageDatesResult = this.parseWithNaturalLanguageDatesPlugin(input);
    if (naturalLanguageDatesResult) {
      return naturalLanguageDatesResult;
    }

    const simpleDates: Record<string, moment.Moment> = {
      today,
      "right now": today,
      tomorrow: today.clone().add(1, "day"),
      tmr: today.clone().add(1, "day"),
      yesterday: today.clone().subtract(1, "day"),
    };

    if (Object.prototype.hasOwnProperty.call(simpleDates, query)) {
      return simpleDates[query].clone();
    }

    const relativeDate = this.parseRelativeDate(query, today);
    if (relativeDate) {
      return relativeDate;
    }

    const namedMonthDate = this.parseNamedMonthDate(query, today);
    if (namedMonthDate) {
      return namedMonthDate;
    }

    const exactDate = obsidianMoment(input.trim(), DATE_INPUT_FORMATS, true);
    if (exactDate.isValid()) {
      return exactDate.startOf("day");
    }

    return null;
  }

  private parseRelativeDate(query: string, today: moment.Moment): moment.Moment | null {
    const unitAliases: Record<string, moment.unitOfTime.DurationConstructor> = {
      day: "day",
      days: "day",
      week: "week",
      weeks: "week",
      month: "month",
      months: "month",
      year: "year",
      years: "year",
    };
    const numberPattern = "(a|an|\\d+)";
    const relativeMatch =
      query.match(new RegExp(`^in ${numberPattern} (${Object.keys(unitAliases).join("|")})$`)) ??
      query.match(new RegExp(`^${numberPattern} (${Object.keys(unitAliases).join("|")}) from now$`));
    if (relativeMatch) {
      const amount = this.parseAmount(relativeMatch[1]);
      if (!Number.isSafeInteger(amount)) return null;
      return today.clone().add(amount, unitAliases[relativeMatch[2]]);
    }

    const agoMatch = query.match(new RegExp(`^${numberPattern} (${Object.keys(unitAliases).join("|")}) ago$`));
    if (agoMatch) {
      const amount = this.parseAmount(agoMatch[1]);
      if (!Number.isSafeInteger(amount)) return null;
      return today.clone().subtract(amount, unitAliases[agoMatch[2]]);
    }

    const simpleRelativeMatch = query.match(/^(next|last) (week|month|year)$/);
    if (simpleRelativeMatch) {
      const [, direction, unit] = simpleRelativeMatch;
      if (direction === "next" && unit === "week") {
        return today.clone().isoWeekday(8);
      }
      if (direction === "next" && unit === "month") {
        return today.clone().add(1, "month").startOf("month");
      }

      const amount = direction === "next" ? 1 : -1;
      return today.clone().add(amount, unit as moment.unitOfTime.DurationConstructor);
    }

    return null;
  }

  private parseNamedMonthDate(query: string, today: moment.Moment): moment.Moment | null {
    const monthAliases = [
      ...moment.months().map((monthName, index) => [monthName.toLowerCase(), index] as const),
      ...moment.monthsShort().map((monthName, index) => [monthName.toLowerCase(), index] as const),
    ];
    const monthPattern = monthAliases.map(([monthName]) => monthName.replace(".", "\\.")).join("|");
    const monthMatch = query.match(new RegExp(`^(next|mid|middle of|start of|end of) (${monthPattern})$`));
    if (!monthMatch) {
      return null;
    }

    const [, modifier, monthName] = monthMatch;
    const targetMonth = monthAliases.find(([alias]) => alias === monthName)?.[1];
    if (targetMonth === undefined) {
      return null;
    }

    const targetDate = today.clone().month(targetMonth).startOf("month");
    if (targetDate.isBefore(today, "month") || (modifier === "next" && targetDate.isSame(today, "month"))) {
      targetDate.add(1, "year");
    }

    if (modifier === "mid" || modifier === "middle of") {
      return targetDate.date(15);
    }
    if (modifier === "end of") {
      return targetDate.endOf("month").startOf("day");
    }

    return targetDate;
  }

  private parseWeekdayDate(query: string, today: moment.Moment): moment.Moment | null {
    const weekdayAliases = WEEKDAYS.flatMap((weekday, index) => [
      [weekday.toLowerCase(), index] as const,
      [weekday.slice(0, 3).toLowerCase(), index] as const,
    ]);
    const weekdayPattern = weekdayAliases.map(([weekday]) => weekday).join("|");
    const weekdayMatch = query.match(new RegExp(`^(?:(next|last|this) )?(${weekdayPattern})$`));
    if (!weekdayMatch) {
      return null;
    }

    const modifier = weekdayMatch[1] ?? "";
    const targetDay = weekdayAliases.find(([weekday]) => weekday === weekdayMatch[2])?.[1];
    if (targetDay === undefined) {
      return null;
    }

    const delta = (targetDay - today.day() + 7) % 7;
    if (modifier === "next") {
      return today.clone().add(delta || 7, "days");
    }
    if (modifier === "last") {
      return today.clone().subtract((today.day() - targetDay + 7) % 7 || 7, "days");
    }
    if (modifier === "this") {
      return today.clone().add(delta, "days");
    }

    return today.clone().add(delta || 7, "days");
  }

  private parseAmount(amount: string): number {
    return amount === "a" || amount === "an" ? 1 : parseInt(amount, 10);
  }

  private parseWithNaturalLanguageDatesPlugin(input: string): moment.Moment | null {
    const pluginManager = (this.app as App & { plugins?: { getPlugin?: (id: string) => unknown } }).plugins;
    const naturalLanguageDatesPlugin = pluginManager?.getPlugin?.("nldates-obsidian") as
      | NaturalLanguageDatesPlugin
      | undefined;
    if (!naturalLanguageDatesPlugin?.parseDate) {
      return null;
    }

    try {
      const result = naturalLanguageDatesPlugin.parseDate(input);
      if (result?.moment?.isValid()) {
        return result.moment.clone().startOf("day");
      }
      if (result?.date instanceof Date && !Number.isNaN(result.date.getTime())) {
        return obsidianMoment(result.date).startOf("day");
      }
    } catch (error) {
      console.error("Weekday Commands: failed to parse date with Natural Language Dates", error);
    }

    return null;
  }

  private getEffectiveDailyNoteSettings(): NativeDailyNoteSettings {
    const nativeSettings = this.getNativeDailyNoteSettings();
    const overriddenFolder = this.normalizeFolder(this.settings.dailyNotesFolder);

    return {
      format: nativeSettings?.format?.trim() || "YYYY-MM-DD",
      folder: overriddenFolder || this.normalizeFolder(nativeSettings?.folder),
      template: nativeSettings?.template?.trim() || "",
    };
  }

  private getNativeDailyNoteSettings(): Partial<NativeDailyNoteSettings> | undefined {
    const pluginManager = (this.app as App & { plugins?: { getPlugin?: (id: string) => unknown } }).plugins;
    const periodicNotes = pluginManager?.getPlugin?.("periodic-notes") as
      | { settings?: { daily?: Partial<NativeDailyNoteSettings> & { enabled?: boolean } } }
      | undefined;
    if (periodicNotes?.settings?.daily?.enabled) {
      return periodicNotes.settings.daily;
    }

    const internalPlugins = (this.app as App & {
      internalPlugins?: { getPluginById?: (id: string) => { instance?: { options?: unknown } } | undefined };
    }).internalPlugins;

    return internalPlugins?.getPluginById?.("daily-notes")?.instance?.options as
      | Partial<NativeDailyNoteSettings>
      | undefined;
  }

  private buildNotePath(filename: string, folder: string): string {
    return normalizePath(folder ? `${folder}/${filename}.md` : `${filename}.md`);
  }

  private normalizeFolder(folder: string | undefined): string {
    const trimmed = (folder ?? "").trim();
    if (!trimmed) return "";
    return normalizePath(trimmed).replace(/^\/+|\/+$/g, "");
  }

  private async ensureFolderExists(folder: string): Promise<void> {
    let path = "";
    for (const part of folder.split("/").filter(Boolean)) {
      path = path ? `${path}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`A file already exists at ${path}.`);
      try {
        await this.app.vault.createFolder(path);
      } catch (error) {
        if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw error;
      }
    }
  }
}

class NaturalLanguageDateModal extends Modal {
  private isSubmitting = false;
  private isClosed = false;
  private input?: TextComponent;
  private submitButton?: HTMLButtonElement;
  private statusEl?: HTMLElement;
  private buttons: HTMLButtonElement[] = [];

  constructor(app: App, private plugin: WeekdayCommandsPlugin) {
    super(app);
  }

  onOpen(): void {
    this.isClosed = false;
    this.modalEl.addClass("weekday-commands-date-modal");
    this.titleEl.setText("Go to daily note");
    this.contentEl.empty();

    const form = this.contentEl.createEl("form", { cls: "weekday-commands-date-form" });
    const input = this.input = new TextComponent(form);
    input.setPlaceholder("Tomorrow, next friday, 2026-09-22");
    input.inputEl.ariaLabel = "Date";
    input.inputEl.required = true;
    input.inputEl.autocomplete = "off";
    input.inputEl.spellcheck = false;
    input.inputEl.addEventListener("input", () => this.statusEl?.setText(""));

    this.submitButton = form.createEl("button", { text: "Open note", cls: "mod-cta" });
    this.submitButton.type = "submit";
    this.buttons = [this.submitButton];
    this.statusEl = this.contentEl.createDiv({ cls: "weekday-commands-date-status" });
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit(() => this.plugin.openDailyNoteFromInput(input.getValue()));
    });

    const recentNotes = this.plugin.getRecentDailyNotes();
    if (recentNotes.length > 0) {
      const suggestions = this.contentEl.createDiv({ cls: "weekday-commands-recent-notes" });
      suggestions.createDiv({
        text: "Recently edited",
        cls: "weekday-commands-recent-notes-label",
      });
      const buttons = suggestions.createDiv({ cls: "weekday-commands-recent-notes-buttons" });

      for (const file of recentNotes) {
        const button = buttons.createEl("button", { text: this.plugin.getDailyNoteLabel(file) });
        button.type = "button";
        button.title = file.path;
        button.setAttribute("aria-label", `Open ${file.path}`);
        this.buttons.push(button);
        button.addEventListener("click", () => {
          void this.submit(() => this.plugin.openRecentDailyNote(file));
        });
      }
    }

    input.inputEl.focus();
  }

  onClose(): void {
    this.isClosed = true;
    this.modalEl.removeClass("weekday-commands-date-modal");
    this.contentEl.empty();
    this.buttons = [];
    this.input = undefined;
    this.submitButton = undefined;
    this.statusEl = undefined;
  }

  private async submit(openNote: () => Promise<boolean>): Promise<void> {
    if (this.isSubmitting || this.isClosed) return;

    this.isSubmitting = true;
    this.contentEl.setAttribute("aria-busy", "true");
    if (this.input) this.input.inputEl.disabled = true;
    for (const button of this.buttons) button.disabled = true;
    this.submitButton?.setText("Opening…");
    this.statusEl?.setText("");
    try {
      if (await openNote()) {
        if (!this.isClosed) this.close();
      } else {
        this.statusEl?.setText("Check the date and daily notes settings, then try again.");
      }
    } catch (error) {
      console.error("Weekday Commands: date picker failed to open a note", error);
      this.statusEl?.setText("Could not open the note. Please try again.");
    } finally {
      this.isSubmitting = false;
      this.contentEl.removeAttribute("aria-busy");
      if (!this.isClosed) {
        if (this.input) this.input.inputEl.disabled = false;
        for (const button of this.buttons) button.disabled = false;
        this.submitButton?.setText("Open note");
        this.input?.inputEl.focus();
        this.input?.inputEl.select();
      }
    }
  }
}

class WeekdayCommandsSettingTab extends PluginSettingTab {
  plugin: WeekdayCommandsPlugin;

  constructor(app: App, plugin: WeekdayCommandsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Integrate with journal view",
        desc: "Send commands to journal view instead of opening notes in tabs. Missing notes are still created.",
        render: (setting) => this.configureJournalViewSetting(setting),
      },
      {
        name: "Daily notes folder",
        desc: "Optional folder override for this plugin. Leave blank to use the daily notes plugin folder.",
        render: (setting) => this.configureDailyNotesFolderSetting(setting),
      },
    ];
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.configureJournalViewSetting(new Setting(containerEl));
    this.configureDailyNotesFolderSetting(new Setting(containerEl));
  }

  private configureJournalViewSetting(setting: Setting): void {
    setting
      .setName("Integrate with journal view")
      .setDesc("Send commands to journal view instead of opening notes in tabs. Missing notes are still created.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.integrateWithJournalView)
        .onChange(async (value) => {
          this.plugin.settings.integrateWithJournalView = value;
          await this.plugin.saveSettings();
        }));
  }

  private configureDailyNotesFolderSetting(setting: Setting): void {
    setting
      .setName("Daily notes folder")
      .setDesc("Optional folder override for this plugin. Leave blank to use the daily notes plugin folder.")
      .addText((text) => {
        text.setPlaceholder("Daily").setValue(this.plugin.settings.dailyNotesFolder);
        text.inputEl.addEventListener("change", () => {
          const value = text.getValue().trim();
          if (value === this.plugin.settings.dailyNotesFolder) return;
          this.plugin.settings.dailyNotesFolder = value;
          void this.plugin.saveSettings();
        });
      });
  }
}

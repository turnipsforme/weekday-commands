const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const moment = require('moment');

moment.now = () => new Date(2026, 8, 19, 12).getTime();
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

class Element {
  constructor(tag = 'div', options = {}) {
    this.tag = tag;
    this.text = options.text || '';
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.disabled = false;
    this.value = '';
  }
  createEl(tag, options) { const el = new Element(tag, options); this.children.push(el); return el; }
  createDiv(options) { return this.createEl('div', options); }
  addClass() {}
  removeClass() {}
  empty() { this.children = []; }
  setText(text) { this.text = text; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}
class TFolder {
  constructor(path) { this.path = path; this.children = []; }
}
class TFile {
  constructor(path, mtime = 0) {
    this.path = path;
    this.basename = path.split('/').pop().replace(/\.md$/, '');
    this.extension = path.split('.').pop();
    this.stat = { mtime };
  }
}
class TextComponent {
  constructor(parent) { this.inputEl = parent.createEl('input'); }
  setPlaceholder(value) { this.inputEl.placeholder = value; return this; }
  setValue(value) { this.inputEl.value = value; return this; }
  getValue() { return this.inputEl.value; }
}

function fixture(options = { format: 'YYYY-MM-DD', folder: 'Daily', template: '' }) {
  const notices = [], opened = [], modals = [], commands = [], cleanups = [];
  class Plugin {
    async loadData() { return {}; }
    async saveData() {}
    addCommand(command) { commands.push(command); }
    addSettingTab(tab) { this.tab = tab; }
    register(callback) { cleanups.push(callback); }
  }
  class Modal {
    constructor() {
      this.modalEl = new Element(); this.titleEl = new Element(); this.contentEl = new Element();
      modals.push(this);
    }
    open() { this.onOpen(); }
    close() { this.closed = true; this.onClose(); }
  }
  class Setting {
    setName() { return this; }
    setDesc() { return this; }
    addText(callback) { const text = new TextComponent(new Element()); this.text = text; callback(text); return this; }
    addToggle(callback) { callback({ setValue() { return this; }, onChange() { return this; } }); return this; }
  }
  const api = {
    Plugin, Modal, Setting, PluginSettingTab: class {}, TFile, TFolder, TextComponent, moment,
    Notice: class { constructor(message) { notices.push(message); } },
    normalizePath: (value) => value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, ''),
  };
  const context = { module: { exports: {} }, require: (name) => { assert.equal(name, 'obsidian'); return api; }, console: { error() {} } };
  vm.runInNewContext(source, context);
  const plugin = new context.module.exports.default();
  const root = new TFolder('/'), files = new Map([['/', root]]), contents = new Map();
  function folder(name) {
    if (!name) return root;
    if (files.has(name)) return files.get(name);
    const entry = new TFolder(name);
    entry.parent = folder(name.split('/').slice(0, -1).join('/'));
    entry.parent.children.push(entry); files.set(name, entry); return entry;
  }
  function file(name, mtime = 0, content = '') {
    const entry = new TFile(name, mtime);
    entry.parent = folder(name.split('/').slice(0, -1).join('/'));
    entry.parent.children.push(entry); files.set(name, entry); contents.set(name, content); return entry;
  }
  const vault = {
    getAbstractFileByPath: (name) => files.get(name),
    getRoot: () => root,
    getMarkdownFiles() { throw new Error('Must not scan the whole vault'); },
    async createFolder(name) {
      assert.ok(!files.has(name));
      const parent = name.split('/').slice(0, -1).join('/');
      assert.ok(!parent || files.get(parent) instanceof TFolder);
      return folder(name);
    },
    async create(name, content) { assert.ok(!files.has(name)); return file(name, 0, content); },
    async cachedRead(entry) { return contents.get(entry.path); },
  };
  plugin.app = {
    vault,
    internalPlugins: { getPluginById: () => ({ instance: { options } }) },
    plugins: { getPlugin: () => undefined },
    metadataCache: { getFirstLinkpathDest: (name) => files.get(name) || files.get(`${name}.md`) },
    workspace: { getLeaf: () => ({ openFile: async (entry) => { opened.push(entry); } }) },
  };
  plugin.settings = { integrateWithJournalView: false, dailyNotesFolder: '' };
  return { plugin, vault, files, contents, folder, file, opened, notices, modals, commands, cleanups, Setting };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const [input, expected] of [
  ['today', '2026-09-19'], ['tomorrow', '2026-09-20'], ['yesterday', '2026-09-18'],
  ['Saturday', '2026-09-26'], ['this Saturday', '2026-09-19'], ['last Saturday', '2026-09-12'],
  ['next Monday', '2026-09-21'], ['in 3 days', '2026-09-22'], ['2 weeks ago', '2026-09-05'],
  ['next week', '2026-09-21'], ['next month', '2026-10-01'], ['next December', '2026-12-01'],
  ['next January', '2027-01-01'], ['next September', '2027-09-01'], ['end of February', '2027-02-28'],
  ['2028-02-29', '2028-02-29'],
]) {
  test(`date: ${input}`, () => {
    assert.equal(fixture().plugin.parseNaturalDate(input)?.format('YYYY-MM-DD'), expected);
  });
}
for (const input of ['2026-02-29', '2026-04-31', 'constructor', '__proto__', 'not a date', '']) {
  test(`rejects invalid input: ${JSON.stringify(input)}`, async () => {
    const { plugin, opened } = fixture();
    assert.equal(await plugin.openDailyNoteFromInput(input), false);
    assert.equal(opened.length, 0);
  });
}
test('rejects overflowing relative dates', async () => {
  assert.equal(await fixture().plugin.openDailyNoteFromInput(`in ${'9'.repeat(100)} years`), false);
});

test('creates every date-format parent and renders templates', async () => {
  const f = fixture({ format: 'YYYY/MM/YYYY-MM-DD', folder: 'Journal', template: 'Template' });
  f.file('Template.md', 0, '{{date}} | {{date:dddd}} | {{yesterday}} | {{tomorrow}} | {{time}}');
  assert.equal(await f.plugin.openDailyNoteFromInput('2026-09-22'), true);
  assert.equal(f.opened[0].path, 'Journal/2026/09/2026-09-22.md');
  assert.equal(f.contents.get(f.opened[0].path), '2026/09/2026-09-22 | Tuesday | 2026/09/2026-09-21 | 2026/09/2026-09-23 | 12:00');
});
test('concurrent opens create the same note only once', async () => {
  const f = fixture(); let creates = 0;
  const create = f.vault.create;
  f.vault.create = async (...args) => { creates++; await tick(); return create(...args); };
  const results = await Promise.all(Array.from({ length: 10 }, () => f.plugin.openDailyNoteFromInput('2026-09-22')));
  assert.ok(results.every(Boolean)); assert.equal(creates, 1); assert.equal(f.plugin.pendingCreations.size, 0);
});
test('concurrent different dates share new parent folders safely', async () => {
  const f = fixture();
  const createFolder = f.vault.createFolder;
  f.vault.createFolder = async (name) => { await tick(); return createFolder(name); };
  assert.ok((await Promise.all(['2026-09-22', '2026-09-23'].map(date => f.plugin.openDailyNoteFromInput(date)))).every(Boolean));
});
test('uses a note created by sync during the create call without overwriting', async () => {
  const f = fixture();
  f.vault.create = async (name) => { f.file(name, 0, 'Synced contents'); throw new Error('Exists'); };
  assert.equal(await f.plugin.openDailyNoteFromInput('2026-09-22'), true);
  assert.equal(f.contents.get(f.opened[0].path), 'Synced contents');
});
test('creation failures return false and can be retried', async () => {
  const f = fixture(); const create = f.vault.create;
  f.vault.create = async () => { throw new Error('Disk full'); };
  assert.equal(await f.plugin.openDailyNoteFromInput('2026-09-22'), false);
  assert.equal(f.notices.length, 1); assert.equal(f.plugin.pendingCreations.size, 0);
  f.vault.create = create;
  assert.equal(await f.plugin.openDailyNoteFromInput('2026-09-22'), true);
});
test('template read failures do not create empty notes or retry twice', async () => {
  const f = fixture({ format: 'YYYY-MM-DD', folder: 'Daily', template: 'Template' });
  f.file('Template.md'); let reads = 0;
  f.vault.cachedRead = async () => { reads++; throw new Error('Read failed'); };
  assert.equal(await f.plugin.openDailyNoteFromInput('tomorrow'), false);
  assert.equal(reads, 1); assert.equal(f.files.has('Daily/2026-09-20.md'), false);
});
test('folder conflicts fail gracefully', async () => {
  const f = fixture(); f.file('Daily');
  assert.equal(await f.plugin.openDailyNoteFromInput('tomorrow'), false);
  assert.equal(f.opened.length, 0);
});

test('recent notes inspect only the configured folder and retain the newest three', () => {
  const f = fixture();
  for (let day = 1; day <= 22; day++) f.file(`Daily/2026-09-${String(day).padStart(2, '0')}.md`, day);
  f.file('Daily/not-a-date.md', 999); f.file('Other/2026-09-25.md', 1000);
  f.file('Daily/Archive/2026-09-25.md', 1001);
  assert.deepEqual(Array.from(f.plugin.getRecentDailyNotes(), file => file.basename), ['2026-09-22', '2026-09-21', '2026-09-17']);
  assert.equal(f.plugin.getRecentDailyNotes(0).length, 0);
});
test('recent notes work at vault root', () => {
  const f = fixture({ format: 'YYYY-MM-DD', folder: '', template: '' });
  f.file('2026-09-01.md'); f.file('Other/2026-09-02.md', 10);
  assert.equal(f.plugin.getRecentDailyNotes()[0].path, '2026-09-01.md');
});
test('nested recent notes and Journal View use the full relative date path', async () => {
  const f = fixture({ format: 'YYYY/MM/DD', folder: 'Daily', template: '' });
  const note = f.file('Daily/2026/09/01.md', 100);
  f.file('Daily/2026/09/19.md', 200);
  f.file('Other/2026/09/02.md', 300);
  assert.equal(f.plugin.getRecentDailyNotes()[0], note);
  assert.equal(f.plugin.getDailyNoteLabel(note), 'Tue, 1 Sep 2026');
  let date;
  f.plugin.settings.integrateWithJournalView = true;
  f.plugin.app.plugins.getPlugin = () => ({ activateView: async (_, value) => { date = value; } });
  assert.equal(await f.plugin.openRecentDailyNote(note), true);
  assert.equal(date.format('YYYY-MM-DD'), '2026-09-01'); assert.equal(f.opened.length, 0);
});
test('missing recent notes remain a recoverable failure', async () => {
  const f = fixture(); const note = f.file('Daily/2026-09-01.md'); f.files.delete(note.path);
  assert.equal(await f.plugin.openRecentDailyNote(note), false);
});
test('Journal View failures fall back to a normal tab', async () => {
  const f = fixture(); f.plugin.settings.integrateWithJournalView = true;
  f.plugin.app.plugins.getPlugin = () => ({ activateView: async () => { throw new Error('Unavailable'); } });
  assert.equal(await f.plugin.openDailyNoteFromInput('tomorrow'), true);
  assert.equal(f.opened.length, 1);
});
test('Natural Language Dates failures fall back to built-in parsing', () => {
  const f = fixture();
  f.plugin.app.plugins.getPlugin = () => ({ parseDate: () => { throw new Error('Unavailable'); } });
  assert.equal(f.plugin.parseNaturalDate('tomorrow').format('YYYY-MM-DD'), '2026-09-20');
});
test('Periodic Notes settings and normalized folder overrides are respected', async () => {
  const f = fixture();
  f.plugin.app.plugins.getPlugin = id => id === 'periodic-notes' ? { settings: { daily: { enabled: true, format: 'YYYY/MM/DD', folder: 'Periodic' } } } : undefined;
  f.plugin.settings.dailyNotesFolder = ' /My//Daily/ ';
  assert.equal(await f.plugin.openDailyNoteFromInput('tomorrow'), true);
  assert.equal(f.opened[0].path, 'My/Daily/2026/09/20.md');
});
test('settings saves run in order with independent snapshots and recover after failure', async () => {
  const f = fixture(); const saved = []; let active = 0;
  f.plugin.saveData = async value => {
    assert.equal(active++, 0); await tick(); saved.push(value.dailyNotesFolder); active--;
    if (saved.length === 1) throw new Error('Write failed');
  };
  f.plugin.settings.dailyNotesFolder = 'First'; const first = f.plugin.saveSettings();
  f.plugin.settings.dailyNotesFolder = 'Second'; const second = f.plugin.saveSettings();
  await Promise.all([first, second]);
  assert.deepEqual(saved, ['First', 'Second']); assert.equal(f.notices.length, 1);
});
test('folder edits save on commit, without writing on every keystroke', async () => {
  const f = fixture(); await f.plugin.onload();
  const setting = new f.Setting(); f.plugin.tab.configureDailyNotesFolderSetting(setting);
  let saves = 0; f.plugin.saveData = async () => { saves++; };
  assert.equal(setting.text.inputEl.listeners.input, undefined);
  setting.text.inputEl.value = 'New folder'; setting.text.inputEl.listeners.change();
  await tick(); assert.equal(saves, 1); assert.equal(f.plugin.settings.dailyNotesFolder, 'New folder');
  setting.text.inputEl.listeners.change(); await tick(); assert.equal(saves, 1);
});
test('picker disables controls, ignores duplicate submits, and recovers from failures', async () => {
  const f = fixture(); await f.plugin.onload(); f.commands[0].callback();
  const modal = f.modals[0], input = modal.input.inputEl;
  assert.equal(input.focused, true); assert.equal(modal.statusEl.attributes.role, 'status');
  let calls = 0, finish;
  const submit = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const pending = modal.submit(submit);
  assert.equal(input.disabled, true); assert.equal(modal.submitButton.text, 'Opening…');
  await modal.submit(submit); assert.equal(calls, 1);
  finish(false); await pending;
  assert.equal(input.disabled, false); assert.equal(modal.isSubmitting, false); assert.ok(modal.statusEl.text);
  await modal.submit(async () => { throw new Error('Failure'); });
  assert.equal(modal.isSubmitting, false); assert.equal(input.disabled, false);
  await modal.submit(async () => true); assert.equal(modal.closed, true);
});
test('closing a pending picker does not steal focus and plugin unload closes its picker', async () => {
  const f = fixture(); await f.plugin.onload(); f.commands[0].callback();
  const modal = f.modals[0], input = modal.input.inputEl;
  let finish; const pending = modal.submit(() => new Promise(resolve => { finish = resolve; }));
  modal.close(); input.focused = false; finish(false); await pending; assert.equal(input.focused, false);
  f.commands[0].callback(); f.cleanups.forEach(callback => callback()); assert.equal(f.modals[1].closed, true);
});
test('large unrelated folders are never enumerated by recent-note lookup', () => {
  const f = fixture(); f.file('Daily/2026-09-01.md');
  const other = f.folder('Unrelated');
  Object.defineProperty(other, 'children', { get() { throw new Error('Unrelated vault scan'); } });
  assert.equal(f.plugin.getRecentDailyNotes().length, 1);
});

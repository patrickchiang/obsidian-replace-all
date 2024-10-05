import { Editor, EditorSelectionOrCaret, Notice, Plugin, setIcon, TFile, View } from 'obsidian';

interface SavedState {
	fileStates: SavedFileState[];
}

interface SavedFileState {
	file: TFile;
	content: string;
}

type SearchView = View & {
	searchParamsContainerEl: HTMLElement;
	dom: { resultDomLookup: Map<TFile, { result: { content: number[][] } }> }
};

interface ReplaceAllPluginSettings {
	replaceAllOn: boolean;
}

const DEFAULT_SETTINGS: ReplaceAllPluginSettings = {
	replaceAllOn: true
}

export default class ReplaceAllPlugin extends Plugin {
	searchView: SearchView;
	saveState: SavedState | undefined;
	settings: ReplaceAllPluginSettings;

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async onload() {
		await this.loadSettings();

		let retries = 0;
		const timedRetry = async () => {
			// wait for search leaf
			const searchLeaves = this.app.workspace.getLeavesOfType('search');
			if (!searchLeaves || searchLeaves.length === 0) {
				if (retries > 20) {
					new Notice('Failed to initialize headings plugin.');
					return;
				} else {
					retries++;
					setTimeout(timedRetry, 1000);
					return;
				}
			}

			const searchLeaf = searchLeaves[0];
			const searchView = await searchLeaf.open(searchLeaf.view) as SearchView;
			this.searchView = searchView;
			this.init();
		};
		timedRetry();

		this.addCommand({
			id: 'restore-replace-all',
			name: 'Undo replace all',
			callback: async () => {
				if (!this.saveState) {
					new Notice('No replace all history to undo.');
					return;
				}

				for (const fileState of this.saveState.fileStates) {
					await this.app.vault.modify(fileState.file, fileState.content);
				}

				new Notice(`Changes in ${this.saveState.fileStates.length} files undone.`);

				this.saveState = undefined;
			}
		});
	}

	async init() {
		this.initReplaceAllRow();
		this.createReplaceAllButton();
	}

	createReplaceAllButton() {
		const searchView = this.searchView;
		const replaceAllParam = document.createElement('div');
		replaceAllParam.classList.add('setting-item');
		replaceAllParam.classList.add('mod-toggle');

		const replaceAllParamInfo = document.createElement('div');
		replaceAllParamInfo.classList.add('setting-item-info');

		const replaceAllParamLabel = document.createElement('div');
		replaceAllParamLabel.classList.add('setting-item-name');
		replaceAllParamLabel.textContent = 'Replace all';

		const replaceAllParamControl = document.createElement('div');
		replaceAllParamControl.classList.add('setting-item-control');

		const replaceAllParamCheckboxContainer = document.createElement('div');
		replaceAllParamCheckboxContainer.classList.add('checkbox-container');
		replaceAllParamCheckboxContainer.classList.add('mod-small');

		if (this.settings.replaceAllOn) {
			replaceAllParamCheckboxContainer.classList.add('is-enabled');
		}

		replaceAllParamCheckboxContainer.addEventListener('click', (event) => {
			replaceAllParamCheckboxContainer.classList.toggle('is-enabled');
			this.toggleReplaceAllRow();

			this.settings.replaceAllOn = !this.settings.replaceAllOn;
			this.saveSettings();
		});

		const replaceAllParamCheckbox = document.createElement('input');
		replaceAllParamCheckbox.type = 'checkbox';

		replaceAllParamInfo.appendChild(replaceAllParamLabel);

		replaceAllParamCheckboxContainer.appendChild(replaceAllParamCheckbox);
		replaceAllParamControl.appendChild(replaceAllParamCheckboxContainer);

		replaceAllParam.appendChild(replaceAllParamInfo);
		replaceAllParam.appendChild(replaceAllParamControl);

		const requestParams = searchView.searchParamsContainerEl;
		requestParams.appendChild(replaceAllParam);
	}

	toggleReplaceAllRow() {
		const searchView = this.searchView;
		const replaceAllRow = searchView.containerEl.querySelector('.search-replace-all-row');
		replaceAllRow?.classList.toggle('hide-replace-all-row');

		const replaceAllButton = searchView.containerEl.querySelector('.search-replace-all');
		replaceAllButton?.classList.toggle('is-active');

		if (!replaceAllRow?.classList.contains('hide-replace-all-row')) {
			replaceAllRow?.querySelector('input')?.focus();
		}
	}

	async initReplaceAllRow() {
		const searchView = this.searchView;
		const searchRow = searchView.containerEl.querySelector('.search-row');

		const replaceAllRow = document.createElement('div');
		replaceAllRow.classList.add('search-replace-all-row');

		const replaceAllIcon = document.createElement('div');
		replaceAllIcon.classList.add('search-replace-all-icon');
		setIcon(replaceAllIcon, 'replace-all');
		replaceAllRow.appendChild(replaceAllIcon);

		const replaceAllField = document.createElement('input');
		replaceAllField.type = 'text';
		replaceAllField.placeholder = 'Replace with...';
		replaceAllField.classList.add('search-replace-all-input');
		replaceAllField.classList.add('clickable-icon');
		replaceAllField.addEventListener('keydown', this.replaceAllKey.bind(this));
		replaceAllRow.appendChild(replaceAllField);

		const replaceAllSubmit = document.createElement('div');
		replaceAllSubmit.classList.add('search-replace-all-submit');
		replaceAllSubmit.classList.add('clickable-icon');
		setIcon(replaceAllSubmit, 'corner-down-left');
		replaceAllSubmit.setAttribute('aria-label', 'Replace all');
		replaceAllSubmit.addEventListener('click', this.replaceAll.bind(this));
		replaceAllRow.appendChild(replaceAllSubmit);

		searchRow?.insertAdjacentElement('afterend', replaceAllRow);
		if (!this.settings.replaceAllOn) {
			replaceAllRow.classList.add('hide-replace-all-row');
		}
	}

	async replaceAllKey(event: KeyboardEvent) {
		if (event.key !== 'Enter') {
			return;
		}
		event.preventDefault();

		await this.replaceAll();
	}

	async replaceAll() {
		const searchView = this.searchView;
		const replaceField = searchView.containerEl.querySelector('.search-replace-all-input') as HTMLInputElement;

		let replacements = 0;
		const searchResults = new Map(searchView.dom.resultDomLookup);
		const vault = this.app.vault;
		this.saveState = { fileStates: [] };
		for (const [key, value] of searchResults.entries()) {
			const file: TFile = key;
			const fileContent = await vault.read(file);
			this.saveState.fileStates.push({ file, content: fileContent });

			const rangeStarts = value.result.content.map((result) => result[0]);
			const rangeEnds = value.result.content.map((result) => result[1]);
			await this.replaceInFile(file, rangeStarts, rangeEnds, replaceField?.value || '');
			replacements += rangeStarts.length;
		}

		new Notice(`Replaced ${replacements} matches.`);
	}

	async replaceInFile(file: TFile, starts: number[], ends: number[], replace: string) {
		if (!file) return;

		await this.app.workspace.openLinkText(file.path, "");
		const activeEditor = this.app.workspace.activeEditor;

		const editingTheCorrectFile = activeEditor?.file === file;
		if (!editingTheCorrectFile) return;

		const editor: Editor | undefined = activeEditor?.editor;
		if (!editor) return;

		const selections: EditorSelectionOrCaret[] = [];

		// @ts-ignore
		const doc = editor.cm.state.doc;

		for (let i = 0; i < starts.length; i++) {
			const start = starts[i];
			const end = ends[i];

			const posStart = doc.lineAt(start);
			const lineStart = posStart.number - 1; // Convert to 0-based line index
			const charStart = start - posStart.from;

			const posEnd = doc.lineAt(end);
			const lineEnd = posEnd.number - 1;
			const charEnd = end - posEnd.from;

			selections.push({ anchor: { line: lineStart, ch: charStart }, head: { line: lineEnd, ch: charEnd } });
		}

		editor.setSelections(selections);
		editor.replaceSelection(replace);
	}
}
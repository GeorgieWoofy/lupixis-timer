// Builds a ready-made Companion page (lupixis-timer-page.companionconfig) from the module's own presets.
// Import it in Companion 5.1+: Import / Export → Import → choose the file → import as a single page.
// Run: npm run page
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { getPresets } = require('../presets')

const CONNECTION_ID = 'lupixis_timer_connection'
const LABEL = 'lupixis'
const id = () => crypto.randomBytes(15).toString('base64url').slice(0, 21)
const val = (value) => ({ value, isExpression: false })
const wrapOptions = (o = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, val(v)]))

// Presets use legacy text sizes; Companion 5 converts them to % of the button height like this.
const fontPercent = (size) => Number((Number(size) * 2.1).toFixed(1))

/** A preset (module format) -> a Companion 5 layered button. */
function toControl(preset) {
	const s = preset.style
	const layers = [
		{ id: 'canvas', name: 'Canvas', usage: 'auto', type: 'canvas', decoration: val('default'), showStatusIcons: val('default') },
		{
			id: 'box0', name: 'Background', usage: 'auto', type: 'box', pinnedProperties: ['color'],
			enabled: val(true), opacity: val(100), x: val(0), y: val(0), width: val(100), height: val(100), rotation: val(0),
			color: val(s.bgcolor), cornerRadius: val(0), borderWidth: val(0), borderColor: val(0), borderPosition: val('inside'),
		},
		{
			id: 'image0', name: 'Image', usage: 'auto', type: 'image', pinnedProperties: ['base64Image', 'halign', 'valign'],
			enabled: val(true), opacity: val(100), x: val(0), y: val(0), width: val(100), height: val(100), rotation: val(0),
			base64Image: val(null), halign: val('center'), valign: val('center'), fillMode: val('fit'),
		},
		{
			id: 'text0', name: 'Text', usage: 'auto', type: 'text', pinnedProperties: ['text', 'fontsize', 'fontsizeAllowShrink', 'color', 'halign', 'valign'],
			enabled: val(true), opacity: val(100), x: val(0), y: val(0), width: val(100), height: val(100), rotation: val(0),
			text: val(s.text.replace(/\\n/g, '\n')), color: val(s.color), halign: val('center'), valign: val('center'),
			fontsize: val(fontPercent(s.size)), fontsizeAllowShrink: val(false), font: val('companion-sans'), weight: val('normal'),
			styles: val([]), outlineColor: val(4278190080),
		},
	]
	const overrides = (style) =>
		Object.entries(style).map(([k, v]) => ({
			overrideId: id(),
			elementId: k === 'bgcolor' ? 'box0' : 'text0',
			elementProperty: k === 'bgcolor' ? 'color' : k === 'color' ? 'color' : 'text',
			override: val(k === 'text' ? String(v).replace(/\\n/g, '\n') : v),
		}))
	return {
		type: 'button-layered',
		style: { layers },
		options: { stepProgression: 'auto', stepExpression: '', rotaryActions: false, canModifyStyleInApis: true, notes: preset.name },
		feedbacks: preset.feedbacks.map((f) => ({
			type: 'feedback', id: id(), connectionId: CONNECTION_ID, definitionId: f.feedbackId, options: wrapOptions(f.options),
			isInverted: val(false), upgradeIndex: -1, styleOverrides: overrides(f.style || {}),
		})),
		steps: {
			0: {
				action_sets: {
					down: preset.steps[0].down.map((a) => ({ type: 'action', id: id(), connectionId: CONNECTION_ID, definitionId: a.actionId, options: wrapOptions(a.options), upgradeIndex: -1 })),
					up: [],
				},
				options: { runWhileHeld: [] },
			},
		},
		localVariables: [],
	}
}

// Presets as the module would build them, with the default quick messages.
const self = {
	label: LABEL,
	state: {
		messagePresets: ['Wrap up', '5 minutes left', 'Speak louder', 'Slow down', 'Take questions now', 'Please finish now'],
		rundown: [],
	},
}
const P = getPresets(self)
// Extra: what's playing in QLab / CasparCG.
const clip = {
	name: 'Clip timer (QLab / CasparCG)',
	style: { text: `CLIP\\n$(${LABEL}:clip_name)\\n$(${LABEL}:clip_remaining)`, size: '7', color: P.flash.style.color, bgcolor: P.flash.style.bgcolor },
	steps: [{ down: [], up: [] }],
	feedbacks: [],
}

// 8×4 grid (Stream Deck XL / Companion default). Column 0 = page navigation, like a normal Companion page.
// The top-left 5×3 block holds the essentials, so a 15-key Stream Deck shows them too.
const layout = [
	[{ type: 'pageup' }, P.time_display, P.toggle, P.stop, P.reset, P.previous, P.next, P.start_next],
	[{ type: 'pagenum' }, P['add_-60'], P.add_60, P['add_-10'], P.add_10, P['add_-300'], P.add_300, P.title],
	[{ type: 'pagedown' }, P.msg_1, P.msg_2, P.msg_3, P.msg_6, P.msg_hide, P.blackout, P.flash],
	[null, P.on_air, P.layout_fullscreen, P.layout_lowerthird, P.layout_bar, P.layout_corner, P.floating, clip],
]

const controls = {}
layout.forEach((row, r) => {
	row.forEach((item, c) => {
		if (!item) return
		controls[r] ??= {}
		controls[r][c] = item.type && !item.style ? item : toControl(item)
	})
})

const config = {
	version: 12, // Companion 5.1 export format
	type: 'page',
	companionBuild: 'lupixis-timer-page-generator',
	page: { id: id(), name: 'Lupixis Timer', controls, gridSize: { minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 }, pageVariables: [] },
	instances: {
		[CONNECTION_ID]: {
			moduleVersionId: 'dev',
			updatePolicy: 'stable',
			sortOrder: 99,
			label: LABEL,
			isFirstInit: false,
			config: { host: '127.0.0.1', port: 4848 },
			lastUpgradeIndex: -1,
			enabled: true,
			moduleInstanceType: 'connection',
			moduleId: 'lupixis-timer',
		},
	},
	connectionCollections: [],
	oldPageNumber: 1,
	imageLibrary: [],
	imageLibraryCollections: [],
}

const out = path.join(__dirname, '..', 'lupixis-timer-page.companionconfig')
fs.writeFileSync(out, JSON.stringify(config, null, '\t'))
console.log(`Wrote ${path.relative(process.cwd(), out)} (${Object.values(controls).reduce((n, r) => n + Object.keys(r).length, 0)} buttons)`)

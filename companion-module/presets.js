// Ready-made Stream Deck buttons. Drag them from Companion's Presets tab onto a page.
const { combineRgb } = require('@companion-module/base')
const { MAX_CUE_VARIABLES } = require('./variables')

// Lupixis Media palette
const WHITE = combineRgb(230, 232, 230) // #E6E8E6
const BLACK = combineRgb(0, 0, 0)
const DARK = combineRgb(39, 41, 43) // #27292B
const GREEN = combineRgb(47, 179, 107)
const YELLOW = combineRgb(253, 202, 64) // #FDCA40
const RED = combineRgb(223, 41, 53) // #DF2935
const ACCENT = combineRgb(55, 114, 255) // #3772FF

/**
 * Pick a text size that fits a 72×72 button without breaking words.
 * Companion 5 scales numeric sizes up (and never shrinks them), while 'auto' shrinks but splits words
 * ("SCREE/N"), so we work out the largest size where the longest word fits on one line and all lines fit.
 * Variables count as `varLen` characters.
 */
const SIZES = [24, 18, 16, 14, 12, 10, 8, 7]
function fitSize(text, varLen = 6) {
	const plain = text.replace(/\$\([^)]*\)/g, 'X'.repeat(varLen)).replace(/\\n/g, '\n')
	const lines = plain.split('\n')
	const longestWord = Math.max(...plain.split(/\s+/).map((w) => w.length), 1)
	for (const size of SIZES) {
		const perLine = Math.floor(70 / size) // characters per line at this size (measured in Companion 5.1)
		if (longestWord > perLine) continue
		// Lines after word-wrapping each explicit line.
		let rows = 0
		for (const line of lines) {
			let len = 0
			rows++
			for (const w of line.split(/\s+/).filter(Boolean)) {
				if (len && len + 1 + w.length > perLine) rows++, (len = w.length)
				else len += (len ? 1 : 0) + w.length
			}
		}
		if (rows <= Math.floor(44 / size)) return String(size)
	}
	return '7'
}

function button(category, name, text, actions, feedbacks = [], style = {}) {
	return {
		type: 'button',
		category,
		name,
		style: { text, size: fitSize(text), color: WHITE, bgcolor: DARK, ...style },
		steps: [{ down: actions.map(([actionId, options = {}]) => ({ actionId, options })), up: [] }],
		feedbacks,
	}
}
const fb = (feedbackId, style, options = {}) => ({ feedbackId, options, style })

function getPresets(self) {
	const v = (name) => `$(${self.label}:${name})`
	const phaseFeedbacks = [
		fb('phase', { bgcolor: YELLOW, color: BLACK }, { phase: 'warning' }),
		fb('phase', { bgcolor: RED, color: WHITE }, { phase: 'critical' }),
		fb('phase', { bgcolor: RED, color: WHITE }, { phase: 'overtime' }),
	]
	const p = {}

	// ---- Timer ----
	p.time_display = button('Timer', 'Time (press = start/pause)', v('time'), [['toggle']], phaseFeedbacks, { size: '12', bgcolor: BLACK })
	p.toggle = button('Timer', 'Start / Pause', `START\\n${v('time')}`, [['toggle']], [
		fb('running', { bgcolor: GREEN, color: WHITE, text: `PAUSE\\n${v('time')}` }),
		fb('paused', { bgcolor: YELLOW, color: BLACK, text: `RESUME\\n${v('time')}` }),
	])
	p.start = button('Timer', 'Start', 'START', [['start']], [fb('running', { bgcolor: GREEN })])
	p.pause = button('Timer', 'Pause', 'PAUSE', [['pause']], [fb('paused', { bgcolor: YELLOW, color: BLACK })])
	p.reset = button('Timer', 'Reset', 'RESET', [['reset']])
	p.stop = button('Timer', 'Stop', 'STOP', [['stop']], [fb('running', { bgcolor: RED, color: WHITE })], { size: '14' })
	p.previous = button('Timer', 'Previous cue', '⏮\\nPREV', [['previous']], [], { size: '14' })
	p.next = button('Timer', 'Next cue', `NEXT\\n${v('next_title')}`, [['next']], [], { size: '8' })
	p.start_next = button('Timer', 'Next and start', `GO NEXT\\n${v('next_title')}`, [['start_next']], [], { size: '8', bgcolor: combineRgb(0, 90, 40) })
	p.title = button('Timer', 'Current cue title', `${v('cue_index')}/${v('cue_count')}\\n${v('cue_title')}`, [], [], { size: '8' })

	// ---- Adjust ----
	for (const [secs, label] of [[-300, '−5m'], [-60, '−1m'], [-10, '−10s'], [10, '+10s'], [60, '+1m'], [300, '+5m']]) {
		p[`add_${secs}`] = button('Adjust time', `${label}`, label, [['add_time', { seconds: secs }]], [], { size: '16' })
	}

	// ---- Messages ----
	const presets = self.state ? self.state.messagePresets : []
	presets.forEach((text, i) => {
		p[`msg_${i + 1}`] = button('Messages', text, text, [['toggle_preset', { index: i + 1, color: 'white', flash: false }]], [
			fb('preset_visible', { bgcolor: RED, color: WHITE }, { index: i + 1 }),
		])
	})
	p.msg_hide = button('Messages', 'Hide message', 'HIDE\\nMSG', [['hide_message']], [fb('message_visible', { bgcolor: RED })])

	// ---- Broadcast ----
	p.on_air = button('Broadcast', 'On air toggle', 'ON\\nAIR', [['on_air', { mode: 'toggle' }]], [fb('on_air', { bgcolor: RED, color: WHITE })])
	for (const [id, label] of [['fullscreen', 'FULL\\nSCREEN'], ['lowerthird', 'LOWER\\nTHIRD'], ['bar', 'BAR'], ['corner', 'CORNER']]) {
		p[`layout_${id}`] = button('Broadcast', `Layout: ${id}`, label, [['layout', { layout: id }]], [fb('layout_active', { bgcolor: ACCENT }, { layout: id })], { size: '10' })
	}

	// ---- Screens ----
	p.blackout = button('Screens', 'Blackout', 'BLACK\\nOUT', [['blackout', { mode: 'toggle' }]], [fb('blackout', { bgcolor: RED })])
	p.flash = button('Screens', 'Flash', 'FLASH', [['flash', { seconds: 3 }]])
	p.floating = button('Screens', 'Floating timer', 'FLOAT\\nTIMER', [['floating', { mode: 'toggle' }]], [fb('floating_open', { bgcolor: ACCENT })])

	// ---- Cues (one button per cue in the current rundown) ----
	const count = self.state ? Math.min(self.state.rundown.filter((c) => !c.kind || c.kind === 'cue').length, MAX_CUE_VARIABLES) : 0
	for (let i = 1; i <= count; i++) {
		p[`cue_${i}`] = button('Cues', `Load cue ${i}`, `${i}\\n${v(`cue_${i}_title`)}`, [['load_cue', { index: i, autostart: false }]], [
			fb('cue_current', { bgcolor: ACCENT, color: WHITE }, { index: i }),
		], { size: '8' })
	}
	return p
}

module.exports = { getPresets }

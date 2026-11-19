const { combineRgb } = require('@companion-module/base')
const { LAYOUTS } = require('./actions')

// Lupixis Media palette
const WHITE = combineRgb(230, 232, 230)
const BLACK = combineRgb(0, 0, 0)
const BLUE = combineRgb(55, 114, 255)
const RED = combineRgb(223, 41, 53)
const YELLOW = combineRgb(253, 202, 64)
const GREEN = combineRgb(47, 179, 107)
const SLATE = combineRgb(58, 61, 65)

function getFeedbacks(self) {
	const s = () => self.state
	const t = () => self.tick || {}
	return {
		running: {
			type: 'boolean',
			name: 'Timer is running',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [],
			callback: () => !!t().running,
		},
		paused: {
			type: 'boolean',
			name: 'Timer is paused',
			defaultStyle: { bgcolor: YELLOW, color: BLACK },
			options: [],
			callback: () => !!t().loaded && !t().running && t().elapsedSeconds > 0,
		},
		phase: {
			type: 'boolean',
			name: 'Timer colour phase',
			description: 'Normal, yellow (warning), red (critical) or overtime',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [
				{
					type: 'dropdown',
					id: 'phase',
					label: 'Phase',
					default: 'overtime',
					choices: [
						{ id: 'normal', label: 'Normal' },
						{ id: 'warning', label: 'Warning (yellow)' },
						{ id: 'critical', label: 'Critical (red)' },
						{ id: 'overtime', label: 'Overtime' },
					],
				},
			],
			callback: (fb) => t().phase === fb.options.phase,
		},
		cue_current: {
			type: 'boolean',
			name: 'Cue is loaded',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [{ type: 'number', id: 'index', label: 'Cue number', default: 1, min: 1, max: 500 }],
			callback: (fb) => t().cueIndex === fb.options.index,
		},
		message_visible: {
			type: 'boolean',
			name: 'A message is on screen',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [],
			callback: () => !!s()?.message.visible,
		},
		preset_visible: {
			type: 'boolean',
			name: 'Quick message is on screen',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [{ type: 'number', id: 'index', label: 'Quick message number', default: 1, min: 1, max: 50 }],
			callback: (fb) => {
				const st = s()
				return !!st && st.message.visible && st.message.text === st.messagePresets[fb.options.index - 1]
			},
		},
		blackout: {
			type: 'boolean',
			name: 'Blackout is on',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [],
			callback: () => !!s()?.blackout,
		},
		on_air: {
			type: 'boolean',
			name: 'Broadcast graphic is on air',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [],
			callback: () => !!s()?.overlay.onAir,
		},
		layout_active: {
			type: 'boolean',
			name: 'Broadcast layout is selected',
			defaultStyle: { bgcolor: SLATE, color: WHITE },
			options: [{ type: 'dropdown', id: 'layout', label: 'Layout', default: 'fullscreen', choices: LAYOUTS }],
			callback: (fb) => s()?.overlay.layout === fb.options.layout,
		},
		floating_open: {
			type: 'boolean',
			name: 'Floating timer is open',
			defaultStyle: { bgcolor: SLATE, color: WHITE },
			options: [],
			callback: () => !!s()?.host?.floatingOpen,
		},
	}
}

module.exports = { getFeedbacks }

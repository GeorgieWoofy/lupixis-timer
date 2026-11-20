const COLORS = [
	{ id: 'white', label: 'White' },
	{ id: 'yellow', label: 'Yellow' },
	{ id: 'red', label: 'Red' },
	{ id: 'green', label: 'Green' },
	{ id: 'blue', label: 'Blue' },
]
const LAYOUTS = [
	{ id: 'fullscreen', label: 'Full screen' },
	{ id: 'lowerthird', label: 'Lower third' },
	{ id: 'bar', label: 'Bar' },
	{ id: 'corner', label: 'Corner' },
]
const TOGGLE = [
	{ id: 'toggle', label: 'Toggle' },
	{ id: 'on', label: 'On' },
	{ id: 'off', label: 'Off' },
]

/** Simple action with no options. */
const simple = (self, name, action) => ({ name, options: [], callback: () => self.send(action) })

function getActions(self) {
	return {
		start: simple(self, 'Timer: Start', 'start'),
		pause: simple(self, 'Timer: Pause', 'pause'),
		toggle: simple(self, 'Timer: Start / Pause', 'toggle'),
		reset: simple(self, 'Timer: Reset current cue (run not recorded)', 'reset'),
		stop: simple(self, 'Timer: Stop current cue (recorded, back to start)', 'stop'),
		next: simple(self, 'Cue: Next (load, not started)', 'next'),
		previous: simple(self, 'Cue: Previous', 'previous'),
		start_next: simple(self, 'Cue: Next and start', 'startNext'),
		load_cue: {
			name: 'Cue: Load by number',
			options: [
				{ type: 'number', id: 'index', label: 'Cue number', default: 1, min: 1, max: 500 },
				{ type: 'checkbox', id: 'autostart', label: 'Start immediately', default: false },
			],
			callback: (a) => self.send('load', { index: a.options.index, autostart: a.options.autostart }),
		},
		add_time: {
			name: 'Timer: Add / subtract time',
			options: [
				{ type: 'number', id: 'seconds', label: 'Seconds (negative to subtract)', default: 60, min: -36000, max: 36000 },
			],
			callback: (a) => self.send('addTime', { seconds: a.options.seconds }),
		},
		set_remaining: {
			name: 'Timer: Set remaining time',
			options: [
				{ type: 'textinput', id: 'time', label: 'Time (5 = 5 min, 4:30, 1:00:00)', default: '5:00', useVariables: true },
			],
			callback: async (a, ctx) => self.send('setRemaining', { text: await ctx.parseVariablesInString(a.options.time) }),
		},
		show_message: {
			name: 'Message: Show text',
			options: [
				{ type: 'textinput', id: 'text', label: 'Message', default: 'Wrap up', useVariables: true },
				{ type: 'dropdown', id: 'color', label: 'Colour', default: 'white', choices: COLORS },
				{ type: 'checkbox', id: 'flash', label: 'Flash', default: false },
			],
			callback: async (a, ctx) =>
				self.send('showMessage', {
					text: await ctx.parseVariablesInString(a.options.text),
					color: a.options.color,
					flash: a.options.flash,
				}),
		},
		show_preset: {
			name: 'Message: Show quick message',
			options: [
				{ type: 'number', id: 'index', label: 'Quick message number', default: 1, min: 1, max: 50 },
				{ type: 'dropdown', id: 'color', label: 'Colour', default: 'white', choices: COLORS },
				{ type: 'checkbox', id: 'flash', label: 'Flash', default: false },
			],
			callback: (a) => self.send('showPreset', { index: a.options.index, color: a.options.color, flash: a.options.flash }),
		},
		toggle_preset: {
			name: 'Message: Toggle quick message',
			options: [
				{ type: 'number', id: 'index', label: 'Quick message number', default: 1, min: 1, max: 50 },
				{ type: 'dropdown', id: 'color', label: 'Colour', default: 'white', choices: COLORS },
				{ type: 'checkbox', id: 'flash', label: 'Flash', default: false },
			],
			callback: (a) => {
				const s = self.state
				const text = s && s.messagePresets[a.options.index - 1]
				if (s && s.message.visible && s.message.text === text) self.send('hideMessage')
				else self.send('showPreset', { index: a.options.index, color: a.options.color, flash: a.options.flash })
			},
		},
		hide_message: simple(self, 'Message: Hide', 'hideMessage'),
		toggle_message: simple(self, 'Message: Show / hide last message', 'toggleMessage'),
		blackout: {
			name: 'Screens: Blackout',
			options: [{ type: 'dropdown', id: 'mode', label: 'Mode', default: 'toggle', choices: TOGGLE }],
			callback: (a) => self.send('blackout', a.options.mode === 'toggle' ? {} : { value: a.options.mode === 'on' }),
		},
		flash: {
			name: 'Screens: Flash',
			options: [{ type: 'number', id: 'seconds', label: 'Seconds', default: 3, min: 1, max: 10 }],
			callback: (a) => self.send('flash', { seconds: a.options.seconds }),
		},
		on_air: {
			name: 'Broadcast: On air',
			options: [{ type: 'dropdown', id: 'mode', label: 'Mode', default: 'toggle', choices: TOGGLE }],
			callback: (a) => self.send({ toggle: 'overlayToggle', on: 'overlayShow', off: 'overlayHide' }[a.options.mode]),
		},
		layout: {
			name: 'Broadcast: Layout',
			options: [{ type: 'dropdown', id: 'layout', label: 'Layout', default: 'fullscreen', choices: LAYOUTS }],
			callback: (a) => self.send('overlayUpdate', { layout: a.options.layout }),
		},
		label: {
			name: 'Broadcast: Set label',
			options: [
				{ type: 'textinput', id: 'label', label: 'Label (empty = use cue title)', default: '', useVariables: true },
				{ type: 'textinput', id: 'subLabel', label: 'Second line', default: '', useVariables: true },
			],
			callback: async (a, ctx) =>
				self.send('overlayUpdate', {
					label: await ctx.parseVariablesInString(a.options.label),
					subLabel: await ctx.parseVariablesInString(a.options.subLabel),
				}),
		},
		floating: {
			name: 'Desktop app: Floating timer',
			options: [{ type: 'dropdown', id: 'mode', label: 'Mode', default: 'toggle', choices: TOGGLE }],
			callback: (a) =>
				self.send('app', { command: { toggle: 'toggleFloating', on: 'openFloating', off: 'closeFloating' }[a.options.mode] }),
		},
		custom: {
			name: 'Advanced: Custom action',
			description: 'Any Lupixis Timer API action, e.g. name "addTime" with parameters {"seconds": 30}',
			options: [
				{ type: 'textinput', id: 'action', label: 'Action name', default: 'toggle' },
				{ type: 'textinput', id: 'params', label: 'Parameters (JSON)', default: '{}', useVariables: true },
			],
			callback: async (a, ctx) => {
				let params = {}
				try {
					params = JSON.parse((await ctx.parseVariablesInString(a.options.params)) || '{}')
				} catch (err) {
					self.log('warn', `Custom action: invalid JSON (${err.message})`)
					return
				}
				self.send(a.options.action.trim(), params)
			},
		},
	}
}

module.exports = { getActions, COLORS, LAYOUTS }

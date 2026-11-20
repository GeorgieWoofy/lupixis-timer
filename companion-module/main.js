// Bitfocus Companion module for Lupixis Timer.
// Connects to Lupixis Timer's WebSocket, exposes actions / feedbacks / variables, and builds ready-made presets.
const { InstanceBase, runEntrypoint, InstanceStatus } = require('@companion-module/base')
const WebSocket = require('ws')
const { getActions } = require('./actions')
const { getFeedbacks } = require('./feedbacks')
const { getVariableDefinitions, MAX_CUE_VARIABLES } = require('./variables')
const { getPresets } = require('./presets')

class LupixisTimerInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.state = null // full show state from Lupixis Timer
		this.tick = {} // pre-formatted time values, updated whenever they change
		this.ws = null
		this.seq = 0
		this.closing = false
		this.definitionsKey = ''
	}

	async init(config) {
		this.config = config
		this.updateDefinitions(true)
		this.connect()
	}

	async destroy() {
		this.closing = true
		clearTimeout(this.reconnectTimer)
		if (this.ws) this.ws.terminate()
	}

	async configUpdated(config) {
		this.config = config
		if (this.ws) this.ws.terminate()
		this.connect()
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Lupixis Timer',
				value:
					'Enter the IP address of the computer running Lupixis Timer. Use 127.0.0.1 if Companion runs on the same computer. The default port is 4848 (shown in Lupixis Timer under Settings).',
			},
			{ type: 'textinput', id: 'host', label: 'Host / IP', width: 8, default: '127.0.0.1' },
			{ type: 'number', id: 'port', label: 'Port', width: 4, default: 4848, min: 1, max: 65535 },
		]
	}

	// ---- connection ----------------------------------------------------------

	connect() {
		clearTimeout(this.reconnectTimer)
		const host = (this.config.host || '127.0.0.1').trim()
		const port = this.config.port || 4848
		this.updateStatus(InstanceStatus.Connecting)
		const ws = new WebSocket(`ws://${host}:${port}/ws`)
		this.ws = ws

		ws.on('open', () => {
			this.updateStatus(InstanceStatus.Ok)
			ws.send(JSON.stringify({ t: 'hello', role: 'companion', ticks: true }))
		})
		ws.on('message', (data) => {
			let msg
			try {
				msg = JSON.parse(data.toString())
			} catch {
				return
			}
			if (msg.t === 'state') this.onState(msg.state)
			else if (msg.t === 'tick') this.onTick(msg)
			else if (msg.t === 'result' && !msg.ok) this.log('warn', `Lupixis Timer: ${msg.error}`)
		})
		ws.on('close', () => {
			if (this.ws !== ws || this.closing) return
			this.updateStatus(InstanceStatus.Disconnected, 'Reconnecting…')
			this.reconnectTimer = setTimeout(() => this.connect(), 2000)
		})
		ws.on('error', (err) => {
			if (this.ws === ws) this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		})
	}

	/** Run a Lupixis Timer action (same names as the HTTP API: start, next, addTime, showMessage …). */
	send(name, params = {}) {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ t: 'action', id: ++this.seq, name, params }))
		} else {
			this.log('warn', `Not connected to Lupixis Timer, "${name}" was not sent`)
		}
	}

	// ---- incoming data -------------------------------------------------------

	onState(s) {
		this.state = s
		this.updateDefinitions()
		const vals = {
			message: s.message.text,
			message_visible: s.message.visible ? 'true' : 'false',
			blackout: s.blackout ? 'true' : 'false',
			on_air: s.overlay.onAir ? 'true' : 'false',
			layout: s.overlay.layout,
		}
		s.rundown.filter((c) => !c.kind || c.kind === 'cue').slice(0, MAX_CUE_VARIABLES).forEach((c, i) => (vals[`cue_${i + 1}_title`] = c.title))
		this.setVariableValues(vals)
		this.checkFeedbacks('message_visible', 'preset_visible', 'blackout', 'on_air', 'layout_active', 'floating_open')
	}

	onTick(t) {
		this.tick = t
		const state = !t.loaded ? 'idle' : t.running ? 'running' : t.elapsedSeconds > 0 ? 'paused' : 'ready'
		this.setVariableValues({
			time: t.display,
			remaining: t.remaining,
			elapsed: t.elapsed,
			remaining_seconds: t.remainingSeconds,
			elapsed_seconds: t.elapsedSeconds,
			progress: t.progress,
			phase: t.phase,
			state,
			overtime: t.overtime ? 'true' : 'false',
			cue_index: t.cueIndex,
			cue_count: t.cueCount,
			cue_title: t.cueTitle,
			cue_speaker: t.cueSpeaker,
			next_title: t.nextTitle,
			clip_name: t.clipName || '',
			clip_remaining: t.clipRemaining || '',
			clip_remaining_seconds: t.clipRemainingSeconds || 0,
		})
		this.checkFeedbacks('running', 'paused', 'phase', 'cue_current')
	}

	/** (Re)build definitions when the rundown length or quick messages change, so presets match the show. */
	updateDefinitions(force = false) {
		const s = this.state
		const key = JSON.stringify([s ? Math.min(s.rundown.filter((c) => !c.kind || c.kind === 'cue').length, MAX_CUE_VARIABLES) : 0, s ? s.messagePresets : []])
		if (!force && key === this.definitionsKey) return
		this.definitionsKey = key
		this.setActionDefinitions(getActions(this))
		this.setFeedbackDefinitions(getFeedbacks(this))
		this.setVariableDefinitions(getVariableDefinitions(this))
		this.setPresetDefinitions(getPresets(this))
	}
}

runEntrypoint(LupixisTimerInstance, [])

const MAX_CUE_VARIABLES = 32

function getVariableDefinitions(self) {
	const defs = [
		{ variableId: 'time', name: 'Time as shown on screens (counts up with + in overtime)' },
		{ variableId: 'remaining', name: 'Remaining time' },
		{ variableId: 'elapsed', name: 'Elapsed time' },
		{ variableId: 'remaining_seconds', name: 'Remaining seconds (negative in overtime)' },
		{ variableId: 'elapsed_seconds', name: 'Elapsed seconds' },
		{ variableId: 'progress', name: 'Progress in percent' },
		{ variableId: 'phase', name: 'Phase: normal / warning / critical / overtime / idle' },
		{ variableId: 'state', name: 'State: running / paused / ready / idle' },
		{ variableId: 'overtime', name: 'In overtime (true/false)' },
		{ variableId: 'cue_index', name: 'Current cue number' },
		{ variableId: 'cue_count', name: 'Number of cues' },
		{ variableId: 'cue_title', name: 'Current cue title' },
		{ variableId: 'cue_speaker', name: 'Current cue speaker' },
		{ variableId: 'next_title', name: 'Next cue title' },
		{ variableId: 'message', name: 'Message text' },
		{ variableId: 'message_visible', name: 'Message on screen (true/false)' },
		{ variableId: 'blackout', name: 'Blackout (true/false)' },
		{ variableId: 'on_air', name: 'Broadcast graphic on air (true/false)' },
		{ variableId: 'layout', name: 'Broadcast layout' },
		{ variableId: 'clip_name', name: 'Playing clip (QLab/CasparCG): name' },
		{ variableId: 'clip_remaining', name: 'Playing clip: time left' },
		{ variableId: 'clip_remaining_seconds', name: 'Playing clip: seconds left' },
	]
	const count = self.state ? Math.min(self.state.rundown.filter((c) => !c.kind || c.kind === 'cue').length, MAX_CUE_VARIABLES) : 0
	for (let i = 1; i <= count; i++) defs.push({ variableId: `cue_${i}_title`, name: `Title of cue ${i}` })
	return defs
}

module.exports = { getVariableDefinitions, MAX_CUE_VARIABLES }

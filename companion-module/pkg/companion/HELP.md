## Lupixis Timer

Controls Lupixis Timer over the network.

**Setup:** enter the IP address of the computer running Lupixis Timer (127.0.0.1 if it is this computer) and the port (default 4848).

### Presets
Open the **Presets** tab and drag buttons onto your Stream Deck page:
- **Timer** – live time display (colour changes yellow / red / overtime), start/pause, next, previous, reset
- **Adjust time** – ±10 s, ±1 min, ±5 min
- **Messages** – one button per quick message (toggles it on the speaker's screen)
- **Broadcast** – On Air toggle and layout selection for the broadcast graphic
- **Screens** – blackout, flash, floating timer
- **Cues** – one button per cue in the current rundown

### Variables
`$(lupixis:time)`, `$(lupixis:remaining)`, `$(lupixis:elapsed)`, `$(lupixis:cue_title)`, `$(lupixis:next_title)`, `$(lupixis:phase)`, `$(lupixis:state)`, `$(lupixis:progress)`, `$(lupixis:cue_1_title)` … and more – see the Variables tab.
(Replace `lupixis` with the label of your connection.)

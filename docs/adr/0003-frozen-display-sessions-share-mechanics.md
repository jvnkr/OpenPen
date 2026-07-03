# Frozen-display sessions share mechanics, not one object

**Status:** accepted

Zoom and the screen eyedropper both freeze the display under the cursor into a
capture, show it on that display's overlay for an interactive session, and
restore normal input on exit. Rather than unify them into one "frozen session"
object, the shared main-process mechanics are extracted as helpers
(`captureDisplay`, `hideUiForFreeze`, `restoreOverlayInput`) while
`toggleZoom`/`exitZoom` and `startEyedrop`/`endEyedrop` stay as separate
orchestrators.

Why: the two flows have real differences — the eyedropper grabs a global Escape
shortcut and returns a picked colour; zoom uses JPEG vs the eyedropper's lossless
PNG; and they interact (starting the eyedropper exits zoom). A full session
abstraction wasn't justified by two adapters with that much variance.

**Consequence:** if a third frozen-surface feature appears (e.g. a region-select
screenshot), revisit unifying these into a single session module — at three
adapters the abstraction likely pays off.

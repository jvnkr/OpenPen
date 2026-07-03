// Toggle the light/dark class through a View Transition so every OpenPen window
// animates a theme change the same way — a short crossfade (see the
// ::view-transition rules in styles/globals.css). Each window runs the API in
// its own document; because they all switch on the same broadcast with the same
// CSS, the animation looks consistent across the toolbar, picker, and settings.
//
// The first application per window is instant: we only want to animate a
// deliberate switch, not the theme being set during the initial paint.
let primed = false

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => unknown
}

export function applyDarkClass(dark: boolean): void {
  const root = document.documentElement
  if (root.classList.contains("dark") === dark) {
    primed = true
    return
  }
  const doc = document as ViewTransitionDocument
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  if (!primed || reduceMotion || typeof doc.startViewTransition !== "function") {
    root.classList.toggle("dark", dark)
    primed = true
    return
  }
  doc.startViewTransition(() => {
    root.classList.toggle("dark", dark)
  })
}

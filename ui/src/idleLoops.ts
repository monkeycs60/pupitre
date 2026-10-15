function isLoop(animation: Animation): boolean {
  return animation.effect?.getTiming().iterations === Infinity
}

function setLoopsPaused(animations: Animation[], paused: boolean) {
  for (const animation of animations) {
    if (!isLoop(animation)) continue
    if (paused && animation.playState === 'running') animation.pause()
    else if (!paused && animation.playState === 'paused') animation.play()
  }
}

/**
 * Fige les animations en boucle tant que la fenêtre n'a pas le focus : sous
 * WebKitGTK, chacune impose une image complète à chaque rafraîchissement.
 */
export function pauseLoopsWhileUnfocused(win: Window = window) {
  const doc = win.document
  let idle = false
  const sync = () => {
    const nextIdle = doc.visibilityState === 'hidden' || !doc.hasFocus()
    if (nextIdle === idle) return
    idle = nextIdle
    setLoopsPaused(doc.getAnimations(), idle)
  }
  // Le focus passe d'abord par un état transitoire sans focus quand il entre
  // dans une iframe : `hasFocus()` ne devient vrai qu'à la tâche suivante.
  const syncLater = () => win.setTimeout(sync, 0)
  const pauseStarted = (event: AnimationEvent) => {
    if (idle && event.target instanceof Element) setLoopsPaused(event.target.getAnimations({ subtree: true }), true)
  }
  win.addEventListener('blur', syncLater)
  win.addEventListener('focus', sync)
  doc.addEventListener('visibilitychange', sync)
  doc.addEventListener('animationstart', pauseStarted, true)
  sync()
}

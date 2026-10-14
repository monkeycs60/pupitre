import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof document === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
        disableFallbackToSetURL: true,
      },
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  })
}

// Sans ce formateur, un expect qui échoue sur un nœud rendu par React sérialise
// tout l'arbre de fibres accroché au nœud : plusieurs secondes par échec, donc
// un waitFor qui dépasse le délai du test au lieu de réessayer.
Object.defineProperty(Node.prototype, Bun.inspect.custom, {
  configurable: true,
  value(this: Node) {
    return this instanceof Element ? this.outerHTML : this.nodeName
  },
})

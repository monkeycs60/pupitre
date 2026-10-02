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

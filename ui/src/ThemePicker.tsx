import { setThemePreference, THEME_OPTIONS, useThemePreference } from './theme'

export function ThemePicker() {
  const preference = useThemePreference()
  return (
    <div className="theme-picker" role="radiogroup" aria-label="Thème">
      {THEME_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={preference === option.value}
          className={`theme-option${preference === option.value ? ' is-active' : ''}`}
          onClick={() => setThemePreference(option.value)}
        >
          <span className={`theme-swatch theme-swatch-${option.value}`} aria-hidden="true">
            <i className="theme-swatch-rail" />
            <i className="theme-swatch-sidebar"><b /><b /><b /></i>
            <i className="theme-swatch-main"><b /><b /><b className="theme-swatch-accent" /></i>
          </span>
          <strong>{option.label}</strong>
          <span>{option.hint}</span>
        </button>
      ))}
    </div>
  )
}

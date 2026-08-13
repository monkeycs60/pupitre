export function BranchIcon({ className = '' }: { className?: string }) {
  return <svg
    className={className}
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
  >
    <circle cx="4" cy="3" r="1.75" stroke="currentColor" strokeWidth="1.25" />
    <circle cx="4" cy="13" r="1.75" stroke="currentColor" strokeWidth="1.25" />
    <circle cx="12" cy="5" r="1.75" stroke="currentColor" strokeWidth="1.25" />
    <path d="M4 4.75v6.5M5.75 10C9.2 10 12 8.6 12 6.75" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
  </svg>
}

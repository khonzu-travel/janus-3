import { useThemeChoice } from '../theme.js';

/**
 * The Janus mark, which is also the theme switch: a click
 * toggles between light and dark and stores the choice. Until then the UI
 * follows the system. The mark is a diamond with one half solid, the two
 * faces of Janus; on hover it mirrors so the solid half looks the other way.
 */
export function ThemeLogo() {
  const [, setChoice, theme] = useThemeChoice();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="group grid size-6 place-items-center rounded-full text-fg hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      onClick={() => {
        setChoice(next);
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        className="transition-transform duration-200 group-hover:-scale-x-100"
      >
        <path d="M12 2L22 12L12 22L2 12Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M12 2L22 12L12 22Z" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

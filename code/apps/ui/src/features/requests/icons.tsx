import type { ReactNode } from 'react';

/**
 * The Requests tab's icons. Each is hidden from
 * assistive technology; the button that holds it carries an `aria-label` and
 * a matching `title`.
 */

interface IconProps {
  readonly className?: string;
}

function Svg({ className = 'size-4', children }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`inline-block shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6h7l2 2h9v11H3z" />
    </Svg>
  );
}

export function NewFolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6h7l2 2h9v11H3z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </Svg>
  );
}

export function NewRequestIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M12 11v6M9 14h6" />
    </Svg>
  );
}

export function EnvironmentIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </Svg>
  );
}

export function ImportIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M4 17v3h16v-3" />
    </Svg>
  );
}

export function RunsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function CollapseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="M16 10l-2 2 2 2" />
    </Svg>
  );
}

export function ExpandIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="M14 10l2 2-2 2" />
    </Svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 4l12 8-12 8z" />
    </Svg>
  );
}

export function LiveIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 3L5 14h6l-1 7 8-11h-6z" />
    </Svg>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="8" y="8" width="12" height="12" rx="1" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </Svg>
  );
}

export function MoveIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6h7l2 2h9v11H3z" />
      <path d="M10 13.5h6M13.5 11l2.5 2.5-2.5 2.5" />
    </Svg>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6" />
    </Svg>
  );
}

/** Save as variable: a value in braces, as `{{name}}` reads. */
export function VariableIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 4c-2 0-2 1-2 3v2c0 1.5-1 3-2 3 1 0 2 1.5 2 3v2c0 2 0 3 2 3" />
      <path d="M16 4c2 0 2 1 2 3v2c0 1.5 1 3 2 3-1 0-2 1.5-2 3v2c0 2 0 3-2 3" />
      <path d="M10 10l4 4M14 10l-4 4" />
    </Svg>
  );
}

/** The default environment; pass `fill-current` in `className` for the filled star. */
export function StarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z" />
    </Svg>
  );
}

/** A window with its right-hand pane marked: show the response in the right pane. */
export function PanelRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
      <path d="M17.5 9h1M17.5 12h1" />
    </Svg>
  );
}

/** A window with its bottom pane marked: show the response under the request. */
export function PanelBottomIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 14h18" />
    </Svg>
  );
}

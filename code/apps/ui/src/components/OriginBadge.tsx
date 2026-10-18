import type { Origin } from '../atlas/wire.js';
import { InheritedIcon, MixedIcon, OwnIcon } from './icons.js';

const ICONS = { own: OwnIcon, inherited: InheritedIcon, mixed: MixedIcon } as const;

/** Where an endpoint's or a file's responses come from, as text with an icon. */
export function OriginBadge({ origin, from }: { readonly origin: Origin; readonly from?: string | null }) {
  const Icon = ICONS[origin];
  const text = origin === 'inherited' && from !== undefined && from !== null ? `from ${from}` : origin;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-label text-faint">
      <Icon className="size-3" />
      {text}
    </span>
  );
}

import { SpinnerIcon } from '../icons.js';

export function LoadingState({ label }: { readonly label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 p-4 text-muted">
      <span role="progressbar" aria-label={label} className="inline-flex">
        <SpinnerIcon className="size-4 motion-safe:animate-spin" />
      </span>
      <span>{label}…</span>
    </div>
  );
}

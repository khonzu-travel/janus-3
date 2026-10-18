/**
 * A path template: `{name}` segments are shown as parameters, set apart
 * visually and, through `describePath`, in the accessible name.
 */
export function PathTemplate({ path, parameters }: { readonly path: string; readonly parameters: readonly string[] }) {
  if (parameters.length === 0) return <>{path}</>;
  const names = new Set(parameters);
  const parts = path.split(/(\{[A-Za-z_][A-Za-z0-9_]*\})/);
  return (
    <>
      {parts.map((part, index) =>
        names.has(part.slice(1, -1)) && part.startsWith('{') ? (
          // Position is the only stable key: the same text can recur.
          <span key={index} className="text-accent" title="Path parameter">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** "/v1/products/{productId}, path parameter productId": how a template is announced. */
export function describePath(path: string, parameters: readonly string[]): string {
  if (parameters.length === 0) return path;
  return `${path}, path parameter${parameters.length === 1 ? '' : 's'} ${parameters.join(', ')}`;
}

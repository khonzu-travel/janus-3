/** An HTTP method in its colour; `DELETE` may be shortened where space is tight. */
export function MethodBadge({ method, short = false }: { readonly method: string; readonly short?: boolean }) {
  return (
    <span className={`method-${method} inline-block font-mono text-label font-medium tracking-wide`}>
      {short && method === 'DELETE' ? (
        <>
          <span aria-hidden="true">DEL</span>
          <span className="sr-only">DELETE</span>
        </>
      ) : (
        method
      )}
    </span>
  );
}
